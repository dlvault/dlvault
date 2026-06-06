import axios, { CancelTokenSource } from 'axios';
import { getSetting, setSetting } from '../database/index';
import { deleteMovie, getMovieById, getMovieByTmdbId, getMovieByImdbId, getAllMovies, getMoviesByStatus, resetRetryCount, updateMovieStatus, type MediaType, type Movie } from '../database/services/movies';
import { requestTitle } from './requests';
import { addLogEntry } from '../database/services/activityLog';
import { logger } from '../utils/logger';
import { eventBus } from './eventbus';
import { pluginRegistry } from '../plugins/registry';

const TELEGRAM_API = 'https://api.telegram.org/bot';

interface FilmResult {
  title: string;
  year: number;
  imdbId: string | null;
  poster: string | null;
  rating: string | null;
  plot: string | null;
  genre: string | null;
  mediaType: MediaType;
}

/**
 * Pull a trailing 4-digit year out of a free-text query so we can pass the
 * bare title to plugin searches (a typical source-site full-text index does
 * not understand "Title YYYY" and returns 0 results). The year is returned
 * separately for downstream filtering/scoring.
 */
export function parseTitleAndYear(input: string): { title: string; year: number | null } {
  const m = input.trim().match(/^(.*?)[\s.\-_(]*(\d{4})\)?\s*$/);
  if (m) {
    const y = parseInt(m[2], 10);
    // Sanity: only treat as year if it is in a plausible range.
    if (y >= 1900 && y <= new Date().getFullYear() + 2) {
      const title = m[1].trim();
      if (title.length >= 2) return { title, year: y };
    }
  }
  return { title: input.trim(), year: null };
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Track user search sessions: chatId -> search results (15 min expiry)
const searchSessions = new Map<number, { results: FilmResult[]; expires: number }>();

// Track which chat IDs requested which movies (for notifications). Bounded by
// time: entries older than REQUESTER_TTL_MS without a re-request are dropped
// in the periodic cleanup so the map can't grow forever for items that never
// hit `download_complete` (the natural delete path).
const REQUESTER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const movieRequesters = new Map<string, { chatIds: Set<number>; lastTouched: number }>(); // "title|year" -> entry

// Reverse index for /meine: chat_id -> set of movie ids this chat has requested.
// Persisted in settings so /meine survives bot restarts.
const chatRequests = new Map<number, Set<number>>();

// Set of chat IDs that have already received the onboarding greeting. Persisted
// in settings so we never greet the same user twice.
const greetedChats = new Set<number>();

// Track progress messages: "title|year" -> { chatId, messageId } for live status updates
const progressMessages = new Map<string, { chatId: number; messageId: number }>();

// Chats (not on the allowlist) we've already pinged the admin about, so a
// stranger who keeps messaging can't spam the owner. Persisted so a restart
// doesn't re-open the floodgate.
const accessRequested = new Set<number>();

// Movie ids we've already sent a "gave up after max retries" Telegram message
// for. Persisted so the once-only notice survives restarts; cleared when the
// user asks to retry (or the item is removed). Prevents the scheduler's
// every-tick max-retries guard from re-pinging the requester forever.
const gaveUpNotified = new Set<number>();

function persistChatRequests(): void {
  try {
    const obj: Record<string, number[]> = {};
    for (const [chatId, ids] of chatRequests) obj[String(chatId)] = [...ids];
    setSetting('telegram.chat_requests', JSON.stringify(obj));
  } catch (err: any) {
    logger.debug(`Telegram: failed to persist chat_requests: ${err.message}`);
  }
}

function loadChatRequests(): void {
  // Always start from a clean slate so a bot restart with cleared settings
  // (or a test that resets settings) doesn't carry over stale entries.
  chatRequests.clear();
  try {
    const raw = getSetting('telegram.chat_requests');
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, number[]>;
    for (const [k, arr] of Object.entries(obj)) {
      chatRequests.set(parseInt(k, 10), new Set(arr));
    }
  } catch (err: any) {
    logger.debug(`Telegram: failed to load chat_requests: ${err.message}`);
  }
}

function persistGreetedChats(): void {
  try {
    setSetting('telegram.greeted_chat_ids', [...greetedChats].join(','));
  } catch (err: any) {
    logger.debug(`Telegram: failed to persist greeted_chat_ids: ${err.message}`);
  }
}

function loadGreetedChats(): void {
  greetedChats.clear();
  try {
    const raw = getSetting('telegram.greeted_chat_ids');
    if (!raw) return;
    for (const s of raw.split(',').map(s => s.trim()).filter(Boolean)) {
      const n = parseInt(s, 10);
      if (Number.isInteger(n)) greetedChats.add(n);
    }
  } catch (err: any) {
    logger.debug(`Telegram: failed to load greeted_chat_ids: ${err.message}`);
  }
}

/** Persist/load helper shared by the two id-set settings below. */
function persistIdSet(key: string, set: Set<number>): void {
  try {
    setSetting(key, [...set].join(','));
  } catch (err: any) {
    logger.debug(`Telegram: failed to persist ${key}: ${err.message}`);
  }
}
function loadIdSet(key: string, set: Set<number>): void {
  set.clear();
  try {
    const raw = getSetting(key);
    if (!raw) return;
    for (const s of raw.split(',').map(s => s.trim()).filter(Boolean)) {
      const n = parseInt(s, 10);
      if (Number.isInteger(n)) set.add(n);
    }
  } catch (err: any) {
    logger.debug(`Telegram: failed to load ${key}: ${err.message}`);
  }
}
const persistAccessRequested = () => persistIdSet('telegram.access_requested_ids', accessRequested);
const loadAccessRequested = () => loadIdSet('telegram.access_requested_ids', accessRequested);
const persistGaveUpNotified = () => persistIdSet('telegram.gave_up_notified_ids', gaveUpNotified);
const loadGaveUpNotified = () => loadIdSet('telegram.gave_up_notified_ids', gaveUpNotified);

// Cleanup expired sessions every 10 minutes
let sessionCleanupTimer: NodeJS.Timeout | null = null;
function startSessionCleanup(): void {
  if (sessionCleanupTimer) return;
  sessionCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [chatId, session] of searchSessions) {
      if (now >= session.expires) searchSessions.delete(chatId);
    }
    for (const [key, entry] of movieRequesters) {
      if (now - entry.lastTouched >= REQUESTER_TTL_MS) movieRequesters.delete(key);
    }
  }, 10 * 60 * 1000);
}
function stopSessionCleanup(): void {
  if (sessionCleanupTimer) { clearInterval(sessionCleanupTimer); sessionCleanupTimer = null; }
}

let pollActive = false;
let lastUpdateId = 0;
let pollCancelSource: CancelTokenSource | null = null;

/**
 * Check if a chat ID is allowed to use the bot.
 * If telegram.allowed_chat_ids is set (comma-separated), only those chats are allowed.
 * If not set, all chats are allowed (backwards compatible).
 */
function isChatAllowed(chatId: number): boolean {
  const allowed = getSetting('telegram.allowed_chat_ids');
  if (!allowed) return true;
  const ids = allowed.split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(String(chatId));
}

/**
 * Gate for mutating/destructive actions (queueing or removing entries). Unlike
 * isChatAllowed, this NEVER fails open: with no allowlist configured, mutations
 * are denied for everyone. Read-only/browse commands stay governed by
 * isChatAllowed so a fresh install is still usable, but a stranger who finds the
 * bot cannot queue downloads or delete items.
 */
function canMutate(chatId: number): boolean {
  if (!getSetting('telegram.allowed_chat_ids')) return false;
  return isChatAllowed(chatId);
}

async function denyMutation(chatId: number, callbackQueryId?: string): Promise<void> {
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId, 'Nicht freigeschaltet');
  await sendMessage(chatId,
    `🔒 Dafür bist du noch nicht freigeschaltet. Gib dem Betreiber deine Chat-ID: <code>${chatId}</code>`);
}

/**
 * The "owner" chat — who gets access-request pings and may approve them. Uses an
 * explicit telegram.admin_chat_id if set, otherwise the first entry in the
 * allowlist (the person who set the bot up adds themselves first). Returns null
 * in open mode (no allowlist), where there's nobody to escalate to.
 */
function getAdminChatId(): number | null {
  const explicit = getSetting('telegram.admin_chat_id');
  if (explicit) {
    const n = parseInt(explicit.trim(), 10);
    if (Number.isInteger(n)) return n;
  }
  const allowed = getSetting('telegram.allowed_chat_ids');
  if (!allowed) return null;
  const first = allowed.split(',').map(s => s.trim()).filter(Boolean)[0];
  const n = first ? parseInt(first, 10) : NaN;
  return Number.isInteger(n) ? n : null;
}

function isAdmin(chatId: number): boolean {
  return getAdminChatId() === chatId;
}

/** Whether this chat is the one that requested the given movie (via Telegram). */
function ownsRequest(chatId: number, movieId: number): boolean {
  return chatRequests.get(chatId)?.has(movieId) ?? false;
}

/** A single-button "try again" keyboard, used on give-up and not-found replies. */
function retryKeyboard(movieId: number): any[][] {
  return [[{ text: '🔁 Nochmal versuchen', callback_data: `retry:${movieId}` }]];
}

/** Retry button only makes sense for an item we gave up on (not_found). */
function alreadyKnownKeyboard(movie: Movie): any[][] | undefined {
  return movie.status === 'not_found' && movie.id ? retryKeyboard(movie.id) : undefined;
}

function getToken(): string {
  return getSetting('telegram.bot_token') || '';
}

function isConfigured(): boolean {
  return !!getToken() && getSetting('telegram.enabled') === 'true';
}

/**
 * Escape user/plugin/OMDb-supplied text before embedding it in a message sent
 * with `parse_mode: 'HTML'`. Without this, a title or plot containing `<`, `>`
 * or `&` breaks Telegram's HTML parser (message rejected / mangled) or injects
 * markup. Only the surrounding template tags are intended as HTML — dynamic
 * values must be escaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  try {
    await axios.post(`${TELEGRAM_API}${getToken()}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }, { timeout: 10000 });
  } catch (error: any) {
    logger.error(`Telegram sendMessage failed: ${error.message}`);
  }
}

async function sendMessageWithKeyboard(chatId: number, text: string, keyboard: any[][]): Promise<void> {
  try {
    await axios.post(`${TELEGRAM_API}${getToken()}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    }, { timeout: 10000 });
  } catch (error: any) {
    logger.error(`Telegram sendMessageWithKeyboard failed: ${error.message}`);
  }
}

async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await axios.post(`${TELEGRAM_API}${getToken()}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text,
    }, { timeout: 10000 });
  } catch (error: any) {
    logger.error(`Telegram answerCallbackQuery failed: ${error.message}`);
  }
}

async function editMessage(chatId: number, messageId: number, text: string, keyboard?: any[][]): Promise<void> {
  try {
    const payload: any = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    };
    if (keyboard) {
      payload.reply_markup = { inline_keyboard: keyboard };
    } else {
      payload.reply_markup = { inline_keyboard: [] };
    }
    await axios.post(`${TELEGRAM_API}${getToken()}/editMessageText`, payload, { timeout: 10000 });
  } catch (error: any) {
    // Ignore "message is not modified" errors
    if (!error.response?.data?.description?.includes('message is not modified')) {
      logger.error(`Telegram editMessage failed: ${error.message}`);
    }
  }
}

async function sendChatAction(chatId: number, action: string): Promise<void> {
  try {
    await axios.post(`${TELEGRAM_API}${getToken()}/sendChatAction`, {
      chat_id: chatId,
      action,
    }, { timeout: 5000 });
  } catch {}
}

async function sendPhoto(chatId: number, photoUrl: string, caption: string, keyboard?: any[][]): Promise<number | null> {
  try {
    const payload: any = {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: 'HTML',
    };
    if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
    const res = await axios.post(`${TELEGRAM_API}${getToken()}/sendPhoto`, payload, { timeout: 10000 });
    return res.data?.result?.message_id || null;
  } catch (error: any) {
    logger.debug(`Telegram sendPhoto failed: ${error.message}`);
    return null;
  }
}

async function sendMessageReturningId(chatId: number, text: string): Promise<number | null> {
  try {
    const res = await axios.post(`${TELEGRAM_API}${getToken()}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }, { timeout: 10000 });
    return res.data?.result?.message_id || null;
  } catch (error: any) {
    logger.error(`Telegram sendMessage failed: ${error.message}`);
    return null;
  }
}

async function fetchMovieDetails(title: string, year: number, imdbId?: string | null): Promise<{ poster: string | null; rating: string | null; plot: string | null; genre: string | null }> {
  let poster: string | null = null;
  let rating: string | null = null;
  let plot: string | null = null;
  let genre: string | null = null;

  // 1. Try OMDb for rich details (rating, plot, genre, poster)
  const omdbKey = getSetting('omdb.api_key');
  if (omdbKey) {
    try {
      const params: any = { apikey: omdbKey, plot: 'short' };
      if (imdbId) {
        params.i = imdbId;
      } else {
        params.t = title;
        params.y = year;
      }
      const res = await axios.get('https://www.omdbapi.com/', { params, timeout: 8000 });
      if (res.data?.Response === 'True') {
        poster = res.data.Poster && res.data.Poster !== 'N/A' ? res.data.Poster : null;
        rating = res.data.imdbRating && res.data.imdbRating !== 'N/A' ? res.data.imdbRating : null;
        plot = res.data.Plot && res.data.Plot !== 'N/A' ? res.data.Plot : null;
        genre = res.data.Genre && res.data.Genre !== 'N/A' ? res.data.Genre : null;
      }
    } catch {}
  }

  // 2. Fallback: poster from any plugin that exposes title search
  if (!poster) {
    try {
      const hits = await pluginRegistry.aggregateSearchTitles(title, { mediaType: 'movie', limit: 5 });
      const match = hits.find(h =>
        normalizeTitle(h.title) === normalizeTitle(title) && (!year || h.year === year),
      );
      if (match?.poster) poster = match.poster;
    } catch {}
  }

  return { poster, rating, plot, genre };
}

async function registerCommands(): Promise<void> {
  try {
    await axios.post(`${TELEGRAM_API}${getToken()}/setMyCommands`, {
      commands: [
        { command: 'start', description: 'Loslegen' },
        { command: 'meine', description: 'Was ich angefragt habe' },
        { command: 'empfehlungen', description: 'Vorschlaege zum Stoebern' },
        { command: 'list', description: 'Was zuletzt dazugekommen ist' },
        { command: 'status', description: 'Was gerade laeuft' },
        { command: 'help', description: 'Hilfe' },
      ],
    }, { timeout: 10000 });
    logger.info('Telegram: bot commands registered');
  } catch (error: any) {
    logger.debug(`Telegram: failed to register commands: ${error.message}`);
  }
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function scoreSearchResult(title: string, query: string): number {
  const t = normalizeTitle(title);
  const q = normalizeTitle(query);

  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 60;
  if (q.includes(t)) return 50;

  const qWords = [...new Set(q.split(/\s+/))];
  const tWords = new Set(t.split(/\s+/));
  const overlap = qWords.filter(w => tWords.has(w)).length;
  return (overlap / qWords.length) * 40;
}

/**
 * Run the plugin title-search either for a specific mediaType, or for both
 * 'movie' and 'show' in parallel when the caller doesn't pre-commit. Results
 * keep the mediaType used for the query so we can route the eventual insert
 * to the correct `media_type` column.
 */
async function searchAcrossMediaTypes(
  query: string,
  opts: { mediaType?: MediaType; limit?: number } = {},
): Promise<Array<{ title: string; year?: number; imdbId?: string | null; poster?: string | null; mediaType: MediaType }>> {
  const limit = opts.limit ?? 5;
  const types: MediaType[] = opts.mediaType ? [opts.mediaType] : ['movie', 'show'];

  const all = await Promise.all(types.map(async t => {
    try {
      const hits = await pluginRegistry.aggregateSearchTitles(query, { mediaType: t, limit });
      return hits.map(h => ({ ...h, mediaType: t }));
    } catch (err: any) {
      logger.debug(`Telegram: ${t} search failed: ${err.message}`);
      return [];
    }
  }));
  return all.flat();
}

function trackProgress(chatId: number, messageId: number, title: string, year: number): void {
  const key = `${title.toLowerCase()}|${year}`;
  progressMessages.set(key, { chatId, messageId });
}

let progressHandler: ((data: any) => void) | null = null;

function setupProgressListener(): void {
  if (progressHandler) return;

  progressHandler = async (data: { id?: number; title?: string; status?: string }) => {
    if (!data.title || !data.status) return;

    const titleLower = data.title.toLowerCase();
    let entry: { chatId: number; messageId: number } | undefined;
    let matchKey: string | undefined;

    for (const [key, val] of progressMessages) {
      if (key.startsWith(titleLower + '|')) {
        entry = val;
        matchKey = key;
        break;
      }
    }
    if (!entry) return;

    const statusMessages: Record<string, string> = {
      searching: '🔍 Ich schau mich um...',
      found: '📦 Hab ihn gefunden!',
      downloading: '⬇️ Lade gerade runter...',
      downloaded: '✅ Ist da! Viel Spass beim Schauen.',
      not_found: '❌ Konnte ihn leider nicht finden. Vielleicht ist er noch nicht erschienen?',
    };

    const msg = statusMessages[data.status];
    if (!msg) return;

    try {
      await editMessage(entry.chatId, entry.messageId,
        `<b>${escapeHtml(data.title)}</b>\n${msg}`
      );
    } catch {}

    // Stop tracking only on a genuinely terminal outcome. Crucially NOT on
    // 'downloading': a download that starts and then dies (links offline →
    // not_found, JD package vanishes → pending → re-search) must keep updating
    // the same message instead of lying as "Lade gerade runter..." forever.
    if (['downloaded', 'not_found'].includes(data.status) && matchKey) {
      progressMessages.delete(matchKey);
    }
  };

  eventBus.on('movie:updated', progressHandler);
}

function cleanupProgressListener(): void {
  if (progressHandler) {
    eventBus.removeListener('movie:updated', progressHandler);
    progressHandler = null;
  }
  progressMessages.clear();
}

function trackRequester(chatId: number, title: string, year: number, movieId?: number): void {
  const key = `${title.toLowerCase()}|${year}`;
  let entry = movieRequesters.get(key);
  if (!entry) {
    entry = { chatIds: new Set(), lastTouched: Date.now() };
    movieRequesters.set(key, entry);
  } else {
    entry.lastTouched = Date.now();
  }
  entry.chatIds.add(chatId);

  if (movieId) {
    let ids = chatRequests.get(chatId);
    if (!ids) { ids = new Set(); chatRequests.set(chatId, ids); }
    ids.add(movieId);
    persistChatRequests();
  }
}

/**
 * Send a one-time welcome message the very first time a chat talks to the bot.
 * The friend on the other end has likely never used a /command bot — keep it
 * conversational. Persists the greeted set in settings so we don't repeat.
 */
async function maybeSendGreeting(chatId: number): Promise<void> {
  if (greetedChats.has(chatId)) return;
  greetedChats.add(chatId);
  persistGreetedChats();
  const customGreeting = getSetting('telegram.welcome_message');
  const text = customGreeting && customGreeting.trim()
    ? customGreeting
    : 'Hi! 👋\n\nIch besorge dir Filme und Serien fuer den Server. Schick mir einfach einen Titel — z. B. <i>Top Gun</i> oder <i>Whistle 2026</i>.\n\nIch melde mich, wenn er da ist.';
  try {
    await sendMessage(chatId, text);
  } catch (err: any) {
    logger.debug(`Telegram: greeting send failed for ${chatId}: ${err.message}`);
  }
}

function getRequesters(title: string, year: number): Set<number> {
  const key = `${title.toLowerCase()}|${year}`;
  return movieRequesters.get(key)?.chatIds ?? new Set();
}

/**
 * A chat that isn't on the allowlist just messaged the (secured) bot. Instead of
 * silently dropping it — which left the friend staring at an unresponsive bot and
 * the owner unaware anyone wanted in — tell the user their request was forwarded
 * and ping the owner once with a one-tap "approve" button. Deduped per chat (and
 * persisted) so a stranger can't spam the owner: exactly one prompt + one ping.
 */
async function handleUnauthorized(
  chatId: number,
  from?: { first_name?: string; username?: string },
  callbackQueryId?: string,
): Promise<void> {
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId);

  if (accessRequested.has(chatId)) {
    logger.debug(`Telegram: access already requested by ${chatId} — ignoring`);
    return;
  }
  accessRequested.add(chatId);
  persistAccessRequested();

  await sendMessage(chatId,
    '🔒 Dieser Bot ist privat. Ich hab den Betreiber gefragt, ob er dich freischaltet — sobald er bestätigt, kannst du loslegen. 🙂');

  const admin = getAdminChatId();
  if (admin == null || admin === chatId) return;

  const name = from?.first_name ? escapeHtml(from.first_name) : 'Jemand';
  const handle = from?.username ? ` (@${escapeHtml(from.username)})` : '';
  logger.info(`Telegram: access requested by ${name}${handle} (chat ${chatId}) — pinging admin ${admin}`);
  await sendMessageWithKeyboard(admin,
    `👤 <b>${name}</b>${handle} möchte den Bot nutzen.\nChat-ID: <code>${chatId}</code>`,
    [
      [{ text: '✅ Freischalten', callback_data: `approve:${chatId}` }],
      [{ text: '🚫 Ignorieren', callback_data: 'cancel' }],
    ]);
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function handleMessage(chatId: number, text: string): Promise<void> {
  // First-message onboarding — fire-and-forget if this chat hasn't been greeted yet.
  await maybeSendGreeting(chatId);

  const trimmed = text.trim();
  const helpText =
    '🎬 <b>So funktioniert\'s</b>\n\n' +
    'Schick mir einfach einen Titel — Film oder Serie — und ich besorge ihn dir.\n' +
    'Beispiele: <i>Top Gun</i>, <i>Whistle 2026</i>, <i>Breaking Bad</i>\n\n' +
    '<b>Was du mir noch schreiben kannst:</b>\n' +
    '/meine — Was du angefragt hast\n' +
    '/empfehlungen — Vorschlaege zum Stoebern\n' +
    '/list — Was zuletzt dazugekommen ist\n' +
    '/status — Was gerade laeuft';

  // /start + /help command
  if (trimmed === '/start' || trimmed === '/help') {
    await sendMessage(chatId, helpText);
    return;
  }

  // /meine — list films this chat has requested
  if (trimmed === '/meine') {
    await handleMeine(chatId);
    return;
  }

  // /empfehlungen — discover feed
  if (trimmed === '/empfehlungen' || trimmed === '/trending') {
    await handleEmpfehlungen(chatId);
    return;
  }

  // /add command — manually add a movie by title (with optional year)
  if (trimmed.startsWith('/add ')) {
    if (!canMutate(chatId)) { await denyMutation(chatId); return; }
    const raw = trimmed.substring(5).trim();
    if (!raw) {
      await sendMessage(chatId, 'Schreib einfach den Titel hinter <b>/add</b>, z. B. <i>/add Top Gun</i>.');
      return;
    }

    const { title: movieTitle, year } = parseTitleAndYear(raw);
    await addManualEntry(chatId, movieTitle, year, 'movie');
    return;
  }

  // /series command — manually add a show by title
  if (trimmed.startsWith('/series ')) {
    const raw = trimmed.substring(8).trim();
    if (!raw) {
      await sendMessage(chatId, 'Schreib einfach den Seriennamen hinter <b>/series</b>.');
      return;
    }
    const { title: seriesTitle, year } = parseTitleAndYear(raw);
    await searchAndShowResults(chatId, seriesTitle, year, 'show');
    return;
  }

  // /cancel — show active items with remove buttons. Kept for power users; not advertised in /help.
  if (trimmed === '/cancel') {
    // Friends only see (and can cancel) their own requests; the owner sees all.
    const canSeeAll = isAdmin(chatId);
    const active = getAllMovies()
      .filter(m => ['pending', 'searching', 'found', 'downloading'].includes(m.status))
      .filter(m => canSeeAll || ownsRequest(chatId, m.id))
      .sort((a, b) => (b.id || 0) - (a.id || 0))
      .slice(0, 10);
    if (active.length === 0) {
      await sendMessage(chatId, 'Da ist gerade nichts unterwegs.');
      return;
    }
    const keyboard = active.map(m => ([
      { text: `${statusLabelFor(m.status)} ${m.title}${m.year ? ' (' + m.year + ')' : ''}`, callback_data: `rm:${m.id}` },
    ]));
    keyboard.push([{ text: '❌ Doch nicht', callback_data: 'cancel' }]);
    await sendMessageWithKeyboard(chatId, '🗑 <b>Was soll weg?</b>', keyboard);
    return;
  }

  // /remove TITLE — remove first matching pending/downloading entry
  if (trimmed.startsWith('/remove ')) {
    if (!canMutate(chatId)) { await denyMutation(chatId); return; }
    const target = trimmed.substring(8).trim();
    if (!target) {
      await sendMessage(chatId, 'Schreib den Titel hinter <b>/remove</b>.');
      return;
    }
    const { title, year } = parseTitleAndYear(target);
    const canRemoveAny = isAdmin(chatId);
    const match = getAllMovies()
      .filter(m => canRemoveAny || ownsRequest(chatId, m.id))
      .find(m =>
        normalizeTitle(m.title) === normalizeTitle(title) && (year == null || m.year === year),
      );
    if (!match) {
      await sendMessage(chatId, `Kann nichts zu "<b>${escapeHtml(title)}</b>" finden.`);
      return;
    }
    deleteMovie(match.id);
    addLogEntry(null, 'movie_removed', `Telegram: ${match.title} (${match.year ?? '—'})`);
    eventBus.emit('movie:updated', { title: match.title });
    await sendMessage(chatId, `🗑 <b>${escapeHtml(match.title)}</b>${match.year ? ' (' + match.year + ')' : ''} ist weg.`);
    return;
  }

  // /status command — give a friendly summary
  if (trimmed === '/status') {
    const movies = getAllMovies();
    const pending = movies.filter(m => m.status === 'pending').length;
    const downloading = movies.filter(m => m.status === 'downloading');
    const downloaded = movies.filter(m => m.status === 'downloaded').length;

    let msg = '';
    if (downloading.length === 0 && pending === 0) {
      msg = '😴 Gerade nichts unterwegs.';
    } else {
      const bits: string[] = [];
      if (downloading.length > 0) bits.push(`⬇️ ${downloading.length} laedt`);
      if (pending > 0) bits.push(`⏳ ${pending} in der Schlange`);
      msg = bits.join(' · ');
    }
    msg += `\n\n📚 ${downloaded} schon auf dem Server.`;

    if (downloading.length > 0) {
      msg += '\n\n<b>Gerade dabei:</b>';
      for (const m of downloading.slice(0, 5)) {
        msg += `\n⬇️ ${escapeHtml(m.title)}${m.year ? ' (' + m.year + ')' : ''}`;
      }
      if (downloading.length > 5) msg += `\n<i>...und ${downloading.length - 5} weitere</i>`;
    }

    await sendMessage(chatId, msg);
    return;
  }

  // /list command — show recently added entries, optionally filtered by status
  if (trimmed === '/list' || trimmed.startsWith('/list ')) {
    const filterArg = trimmed.length > 5 ? trimmed.substring(6).trim().toLowerCase() : '';
    const statusMap: Record<string, string> = {
      pending: 'pending', warten: 'pending', wartet: 'pending',
      searching: 'searching', suche: 'searching',
      found: 'found',
      downloading: 'downloading', laedt: 'downloading',
      downloaded: 'downloaded', fertig: 'downloaded',
      notfound: 'not_found', not_found: 'not_found', nichtgefunden: 'not_found',
    };
    const statusFilter = filterArg ? statusMap[filterArg] : null;
    if (filterArg && !statusFilter) {
      await sendMessage(chatId,
        `Unbekannter Filter "<b>${escapeHtml(filterArg)}</b>".\n` +
        'Verfuegbar: pending, downloading, downloaded, notfound.'
      );
      return;
    }

    const recent = getAllMovies()
      .filter(m => !statusFilter || m.status === statusFilter)
      .sort((a, b) => (b.id || 0) - (a.id || 0))
      .slice(0, 10);

    if (recent.length === 0) {
      await sendMessage(chatId, statusFilter
        ? 'Hier ist gerade nichts zu sehen.'
        : 'Hier ist gerade noch nichts.');
      return;
    }

    const header = statusFilter
      ? '📋 <b>Die letzten 10:</b>'
      : '📋 <b>Zuletzt dazugekommen:</b>';
    let msg = header + '\n';
    for (const m of recent) {
      const typeIcon = m.media_type === 'show' ? '📺' : '🎬';
      const icon = statusIconFor(m.status);
      msg += `\n${icon} ${typeIcon} ${escapeHtml(m.title)}${m.year ? ' (' + m.year + ')' : ''}`;
    }

    await sendMessage(chatId, msg);
    return;
  }

  // Free-text search — auto-detect year, search across movie + show plugins
  const { title: searchTitle, year: searchYear } = parseTitleAndYear(trimmed);
  await searchAndShowResults(chatId, searchTitle, searchYear);
}

function statusIconFor(status: string): string {
  const icons: Record<string, string> = {
    pending: '⏳',
    searching: '🔍',
    found: '📦',
    downloading: '⬇️',
    downloaded: '✅',
    not_found: '❌',
  };
  return icons[status] || '❓';
}

/**
 * Friendly per-status label for /cancel buttons and /meine. No tech-speak —
 * "downloading" becomes "laedt gerade" so non-techies recognize the state.
 */
function statusLabelFor(status: string): string {
  const labels: Record<string, string> = {
    pending: '⏳ wartet',
    searching: '🔍 wird gesucht',
    found: '📦 gefunden',
    downloading: '⬇️ laedt',
    downloaded: '✅ fertig',
    not_found: '❌ nicht gefunden',
  };
  return labels[status] || status;
}

/**
 * /meine — list the films this chat has personally requested, with current
 * status. Backed by the persisted reverse index built up by trackRequester.
 */
async function handleMeine(chatId: number): Promise<void> {
  const ids = chatRequests.get(chatId);
  if (!ids || ids.size === 0) {
    await sendMessage(chatId, 'Du hast bisher noch nichts angefragt — schick mir einfach einen Titel.');
    return;
  }

  const movies: Movie[] = [];
  const stale: number[] = [];
  for (const id of ids) {
    const m = getMovieById(id);
    if (m) movies.push(m);
    else stale.push(id);
  }
  // Garbage-collect references to deleted movies.
  if (stale.length > 0) {
    for (const id of stale) ids.delete(id);
    persistChatRequests();
  }

  if (movies.length === 0) {
    await sendMessage(chatId, 'Deine Anfragen wurden alle entfernt oder sind nicht mehr verfuegbar.');
    return;
  }

  movies.sort((a, b) => (b.id || 0) - (a.id || 0));
  let msg = '🎬 <b>Deine Anfragen:</b>\n';
  for (const m of movies.slice(0, 15)) {
    const typeIcon = m.media_type === 'show' ? '📺' : '🎬';
    msg += `\n${statusLabelFor(m.status)} ${typeIcon} ${escapeHtml(m.title)}${m.year ? ' (' + m.year + ')' : ''}`;
  }
  if (movies.length > 15) msg += `\n<i>...und ${movies.length - 15} weitere</i>`;

  await sendMessage(chatId, msg);
}

/**
 * /empfehlungen — surface what plugins are trending so users without a
 * specific title in mind can browse. Reuses the existing session/keyboard
 * machinery so tapping a card opens the same "select → confirm" flow as a
 * normal search.
 */
async function handleEmpfehlungen(chatId: number): Promise<void> {
  await sendChatAction(chatId, 'typing');
  try {
    // Use the cached feed if populated — keeps response snappy. Only hit the
    // network when nothing is cached yet (cold start).
    let movieItems = pluginRegistry.getCachedDiscover('movie');
    let showItems = pluginRegistry.getCachedDiscover('show');
    if ((movieItems.length + showItems.length) === 0) {
      movieItems = await pluginRegistry.aggregateDiscover('movie');
      showItems = await pluginRegistry.aggregateDiscover('show');
    }

    const seen = new Set<string>();
    const combined: FilmResult[] = [];
    const addAll = (items: typeof movieItems, mt: MediaType) => {
      for (const it of items) {
        const key = `${it.title.toLowerCase()}|${it.year || ''}|${mt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        combined.push({
          title: it.title,
          year: it.year || 0,
          imdbId: null,
          poster: it.poster || null,
          rating: null,
          plot: it.description || null,
          genre: it.genres?.join(', ') || null,
          mediaType: mt,
        });
      }
    };
    addAll(movieItems, 'movie');
    addAll(showItems, 'show');
    const picks = combined.slice(0, 6);

    if (picks.length === 0) {
      await sendMessage(chatId, 'Gerade keine Empfehlungen verfuegbar — schick mir einfach einen Titel, den du dir wuenschst.');
      return;
    }

    searchSessions.set(chatId, { results: picks, expires: Date.now() + 15 * 60 * 1000 });
    const keyboard = picks.map((r, i) => ([
      { text: `${r.mediaType === 'show' ? '📺' : '🎬'} ${r.title}${r.year ? ' (' + r.year + ')' : ''}`, callback_data: `select:${i}` }
    ]));
    keyboard.push([{ text: '❌ Schliessen', callback_data: 'cancel' }]);
    await sendMessageWithKeyboard(chatId, '✨ <b>Vielleicht was hiervon?</b>', keyboard);
  } catch (err: any) {
    logger.error(`Telegram empfehlungen failed: ${err.message}`);
    await sendMessage(chatId, '❌ Konnte gerade keine Empfehlungen laden.');
  }
}

/**
 * Insert a manually-typed entry (movie or show) into the queue and trigger
 * an immediate search. Used by /add, /series, and the "add_manual" fallback
 * after a failed search. Year is optional — null lets the scheduler pick it
 * up from the plugin instead of writing a bogus current-year value.
 */
async function addManualEntry(
  chatId: number,
  title: string,
  year: number | null,
  mediaType: MediaType,
): Promise<void> {
  const allMovies = getAllMovies();
  const existing = allMovies.find(m =>
    normalizeTitle(m.title) === normalizeTitle(title) && (year == null || m.year === year)
  );
  if (existing) {
    const kb = alreadyKnownKeyboard(existing);
    if (kb) await sendMessageWithKeyboard(chatId, alreadyKnownMessage(existing), kb);
    else await sendMessage(chatId, alreadyKnownMessage(existing));
    if (existing.id) trackRequester(chatId, existing.title, existing.year ?? 0, existing.id);
    return;
  }

  const minQuality = getSetting('quality.minimum') || '1080p';
  const { movie: inserted } = await requestTitle({
    trakt_id: null,
    imdb_id: '',
    tmdb_id: null,
    title,
    year,
    slug: slugify(title),
    media_type: mediaType,
    status: 'pending',
    desired_quality: minQuality,
  });

  const effectiveYear = year ?? 0;
  trackRequester(chatId, title, effectiveYear, inserted?.id);
  addLogEntry(inserted?.id ?? null, 'movie_added', `Telegram (manuell): ${title}${year ? ' (' + year + ')' : ''}`);
  eventBus.emit('movie:updated', { title });

  // Single combined "got your request" message that the progress listener will
  // edit as the state advances — no double-ping.
  const typeIcon = mediaType === 'show' ? '📺' : '🎬';
  const progressMsgId = await sendMessageReturningId(chatId,
    `${typeIcon} <b>${escapeHtml(title)}</b>${year ? ' (' + year + ')' : ''}\n🔍 Ich schau mich um...`
  );
  if (progressMsgId) trackProgress(chatId, progressMsgId, title, effectiveYear);

  logger.info(`Telegram: manual add - ${title} (${year ?? '—'}) [${mediaType}] by chat ${chatId}`);
  triggerImmediateProcessing(title, effectiveYear, chatId);
}

/**
 * Friendly "I've already heard about this" message used when the user requests
 * something that is already known (in the queue, downloading, or done).
 */
function alreadyKnownMessage(movie: Movie): string {
  const head = `<b>${escapeHtml(movie.title)}</b>${movie.year ? ' (' + movie.year + ')' : ''}`;
  switch (movie.status) {
    case 'downloaded':
      return `✅ ${head} liegt schon auf dem Server — viel Spass beim Schauen!`;
    case 'downloading':
      return `⬇️ ${head} laedt gerade — gleich fertig.`;
    case 'searching':
    case 'pending':
    case 'found':
      return `⏳ ${head} ist schon auf meiner Liste, ich bin dran.`;
    case 'not_found':
      return `❌ ${head} hab ich neulich nicht gefunden. Vielleicht klappt's jetzt — soll ich's nochmal probieren?`;
    default:
      return `ℹ️ ${head} kenne ich schon.`;
  }
}

/**
 * Run a plugin + OMDb fallback search and present the disambiguation
 * keyboard. Extracted so /series, /add, and free-text search share the path.
 */
async function searchAndShowResults(
  chatId: number,
  title: string,
  year: number | null,
  mediaType?: MediaType,
): Promise<void> {
  const display = title + (year ? ` (${year})` : '');
  try {
    await sendChatAction(chatId, 'typing');

    let resultList: FilmResult[] = [];
    try {
      const hits = await searchAcrossMediaTypes(title, { mediaType, limit: 5 });
      const seen = new Set<string>();
      resultList = hits
        // Score against the bare title; year is only used for filtering, not ranking.
        .sort((a, b) => scoreSearchResult(b.title, title) - scoreSearchResult(a.title, title))
        // If the user gave a year, drop candidates with a different year. Keep
        // candidates with no year (some shows don't expose one).
        .filter(h => year == null || !h.year || h.year === year)
        .filter(h => {
          const key = `${h.title.toLowerCase()}|${h.year || ''}|${h.mediaType}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 5)
        .map(h => ({
          title: h.title,
          year: h.year || 0,
          imdbId: h.imdbId || null,
          poster: h.poster || null,
          rating: null,
          plot: null,
          genre: null,
          mediaType: h.mediaType,
        }));
    } catch (pluginErr: any) {
      logger.debug(`Telegram: plugin title search failed: ${pluginErr.message}`);
    }

    // OMDb fallback only applies to movies (and only if the user didn't ask for shows).
    if (resultList.length === 0 && mediaType !== 'show') {
      const omdbKey = getSetting('omdb.api_key');
      if (omdbKey) {
        try {
          const omdbRes = await axios.get(`https://www.omdbapi.com/`, {
            params: { apikey: omdbKey, s: title, type: 'movie', ...(year ? { y: year } : {}) },
            timeout: 10000,
          });
          const omdbResults = omdbRes.data?.Search || [];
          resultList = omdbResults.slice(0, 5).map((r: any) => ({
            title: r.Title,
            year: parseInt(r.Year) || 0,
            imdbId: r.imdbID || null,
            poster: r.Poster && r.Poster !== 'N/A' ? r.Poster : null,
            rating: null,
            plot: null,
            genre: null,
            mediaType: 'movie' as MediaType,
          }));
          if (resultList.length > 0) {
            logger.info(`Telegram: no plugin candidates, OMDb found ${resultList.length} for "${title}"`);
          }
        } catch (e: any) {
          logger.debug(`OMDb search failed: ${e.message}`);
        }
      }
    }

    if (resultList.length === 0) {
      const tip = year
        ? `Tipp: einfach ohne Jahr probieren — <i>${escapeHtml(title)}</i>.`
        : 'Tipp: vielleicht den Originaltitel oder eine kuerzere Schreibweise versuchen.';
      const manualPayload = `${title}${year ? '|' + year : ''}|${mediaType ?? 'movie'}`;
      await sendMessageWithKeyboard(chatId,
        `Konnte zu "<b>${escapeHtml(display)}</b>" nichts finden.\n${tip}`,
        [[{ text: '📝 Trotzdem auf die Liste', callback_data: `add_manual:${manualPayload}` }]]
      );
      return;
    }

    // Save session (expires in 15 minutes)
    searchSessions.set(chatId, { results: resultList, expires: Date.now() + 15 * 60 * 1000 });

    // Build inline keyboard — one button per result, prefixed with media-type icon
    const keyboard = resultList.map((r, i) => ([
      { text: `${r.mediaType === 'show' ? '📺' : '🎬'} ${r.title}${r.year ? ' (' + r.year + ')' : ''}`, callback_data: `select:${i}` }
    ]));
    keyboard.push([{ text: '❌ Doch nicht', callback_data: 'cancel' }]);

    await sendMessageWithKeyboard(chatId, '🎬 <b>Welchen meinst du?</b>', keyboard);
  } catch (error: any) {
    logger.error(`Telegram search failed: ${error.message}`);
    await sendMessage(chatId, '❌ Ups — da ist was schiefgegangen. Probier es bitte gleich nochmal.');
  }
}

// ── Callback Handling (Inline Keyboard) ───────────────────────────────────────

async function handleCallback(chatId: number, messageId: number, callbackQueryId: string, data: string): Promise<void> {
  // Cancel button
  if (data === 'cancel') {
    searchSessions.delete(chatId);
    await answerCallbackQuery(callbackQueryId);
    await editMessage(chatId, messageId, '👌 Alles klar.');
    return;
  }

  // Owner taps "Freischalten" on an access-request ping → add the chat to the
  // allowlist and tell the new user they're in. Only the admin may approve.
  if (data.startsWith('approve:')) {
    if (!isAdmin(chatId)) { await answerCallbackQuery(callbackQueryId, 'Nur der Betreiber kann freischalten'); return; }
    const newId = parseInt(data.substring(8), 10);
    if (!Number.isInteger(newId)) { await answerCallbackQuery(callbackQueryId, 'Ungueltig'); return; }

    const allowed = getSetting('telegram.allowed_chat_ids') || '';
    const ids = allowed.split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.includes(String(newId))) {
      ids.push(String(newId));
      setSetting('telegram.allowed_chat_ids', ids.join(','));
    }
    accessRequested.delete(newId); persistAccessRequested();
    // Skip the generic onboarding greeting — the unlock message below is the intro.
    greetedChats.add(newId); persistGreetedChats();
    addLogEntry(null, 'telegram_access_granted', `Telegram: chat ${newId} freigeschaltet`);
    logger.info(`Telegram: chat ${newId} unlocked by admin ${chatId}`);

    await answerCallbackQuery(callbackQueryId, 'Freigeschaltet');
    await editMessage(chatId, messageId, `✅ Freigeschaltet. Viel Spass!`);
    await sendMessage(newId,
      '🎉 Du bist freigeschaltet! Schick mir einfach einen Filmtitel — z. B. <i>Top Gun</i> — und ich besorge ihn dir.');
    return;
  }

  // "Nochmal versuchen" on a not-found / gave-up item: reset the retry counter
  // and re-queue, then live-track the same message again.
  if (data.startsWith('retry:')) {
    if (!canMutate(chatId)) { await denyMutation(chatId, callbackQueryId); return; }
    const id = parseInt(data.substring(6), 10);
    if (!Number.isInteger(id)) { await answerCallbackQuery(callbackQueryId, 'Ungueltig'); return; }
    const movie = getMovieById(id);
    if (!movie) {
      await answerCallbackQuery(callbackQueryId, 'Schon weg');
      await editMessage(chatId, messageId, 'ℹ️ Den gibt es nicht mehr.');
      return;
    }
    if (!isAdmin(chatId) && !ownsRequest(chatId, id)) {
      await answerCallbackQuery(callbackQueryId, 'Nicht deine Anfrage');
      return;
    }

    resetRetryCount(id);
    updateMovieStatus(id, 'pending');
    gaveUpNotified.delete(id); persistGaveUpNotified();
    trackRequester(chatId, movie.title, movie.year ?? 0, id);
    addLogEntry(id, 'retry_requested', `Telegram: ${movie.title}`);
    eventBus.emit('movie:updated', { title: movie.title });

    await answerCallbackQuery(callbackQueryId, 'Alles klar!');
    const typeIcon = movie.media_type === 'show' ? '📺' : '🎬';
    await editMessage(chatId, messageId,
      `${typeIcon} <b>${escapeHtml(movie.title)}</b>${movie.year ? ' (' + movie.year + ')' : ''}\n🔁 Ich versuch's nochmal...`);
    trackProgress(chatId, messageId, movie.title, movie.year ?? 0);
    triggerImmediateProcessing(movie.title, movie.year ?? 0, chatId);
    return;
  }

  // Manual add from "not found" screen. Payload formats (pipe-separated):
  //   add_manual:Title                         — legacy / free-text fallback
  //   add_manual:Title|YYYY|movie|show         — new format with year + mediaType
  if (data.startsWith('add_manual:')) {
    if (!canMutate(chatId)) { await denyMutation(chatId, callbackQueryId); return; }
    const payload = data.substring(11);
    const parts = payload.split('|');
    const movieTitle = parts[0];
    const parsedYear = parts[1] ? parseInt(parts[1], 10) : NaN;
    const year: number | null = Number.isInteger(parsedYear) ? parsedYear : null;
    const mediaType: MediaType = parts[2] === 'show' ? 'show' : 'movie';

    await answerCallbackQuery(callbackQueryId);
    const allMovies = getAllMovies();
    const existing = allMovies.find(m =>
      normalizeTitle(m.title) === normalizeTitle(movieTitle) && (year == null || m.year === year)
    );
    if (existing) {
      await editMessage(chatId, messageId, alreadyKnownMessage(existing), alreadyKnownKeyboard(existing));
      if (existing.id) trackRequester(chatId, existing.title, existing.year ?? 0, existing.id);
      return;
    }

    const minQuality = getSetting('quality.minimum') || '1080p';
    const { movie: inserted } = await requestTitle({
      trakt_id: null, imdb_id: '', tmdb_id: null,
      title: movieTitle, year,
      slug: slugify(movieTitle),
      media_type: mediaType, status: 'pending', desired_quality: minQuality,
    });
    const effectiveYear = year ?? 0;
    trackRequester(chatId, movieTitle, effectiveYear, inserted?.id);
    addLogEntry(inserted?.id ?? null, 'movie_added', `Telegram (manuell): ${movieTitle}${year ? ' (' + year + ')' : ''}`);
    eventBus.emit('movie:updated', { title: movieTitle });

    const typeIcon = mediaType === 'show' ? '📺' : '🎬';
    await editMessage(chatId, messageId,
      `${typeIcon} <b>${escapeHtml(movieTitle)}</b>${year ? ' (' + year + ')' : ''}\n🔍 Ich schau mich um...`);
    // The edited message itself becomes the progress message — no second ping.
    trackProgress(chatId, messageId, movieTitle, effectiveYear);

    logger.info(`Telegram: manual add - ${movieTitle} (${year ?? '—'}) [${mediaType}] by chat ${chatId}`);
    triggerImmediateProcessing(movieTitle, effectiveYear, chatId);
    return;
  }

  // /cancel inline removal: rm:<id>
  if (data.startsWith('rm:')) {
    if (!canMutate(chatId)) { await denyMutation(chatId, callbackQueryId); return; }
    const id = parseInt(data.substring(3), 10);
    if (!Number.isInteger(id)) {
      await answerCallbackQuery(callbackQueryId, 'Ungueltig');
      return;
    }
    const movie = getAllMovies().find(m => m.id === id);
    if (!movie) {
      await answerCallbackQuery(callbackQueryId, 'Schon weg');
      await editMessage(chatId, messageId, 'ℹ️ Der ist schon nicht mehr da.');
      return;
    }
    if (!isAdmin(chatId) && !ownsRequest(chatId, id)) {
      await answerCallbackQuery(callbackQueryId, 'Nicht deine Anfrage');
      return;
    }
    deleteMovie(id);
    addLogEntry(null, 'movie_removed', `Telegram: ${movie.title} (${movie.year ?? '—'})`);
    eventBus.emit('movie:updated', { title: movie.title });
    await answerCallbackQuery(callbackQueryId, 'Weg');
    await editMessage(chatId, messageId,
      `🗑 <b>${escapeHtml(movie.title)}</b>${movie.year ? ' (' + movie.year + ')' : ''} ist weg.`);
    return;
  }

  // Select a search result → show details with a single confirm button
  if (data.startsWith('select:')) {
    const index = parseInt(data.substring(7), 10);
    const session = searchSessions.get(chatId);
    if (!session || Date.now() >= session.expires) {
      await answerCallbackQuery(callbackQueryId, 'Auswahl abgelaufen');
      await editMessage(chatId, messageId, '⏰ Das ist zu lange her — schreib mir den Titel einfach nochmal.');
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= session.results.length) {
      await answerCallbackQuery(callbackQueryId, 'Ungueltige Auswahl');
      return;
    }

    const film = session.results[index];
    await answerCallbackQuery(callbackQueryId);
    await editMessage(chatId, messageId, '⏳ Einen Moment...');

    // Fetch rich details from OMDb if not yet loaded
    if (!film.rating) {
      const existingPoster = film.poster;
      const details = await fetchMovieDetails(film.title, film.year, film.imdbId);
      Object.assign(film, details);
      // Keep source-page poster if OMDb didn't have one
      if (!film.poster && existingPoster) film.poster = existingPoster;
    }

    // Send poster as standalone photo if available
    if (film.poster) {
      await sendPhoto(chatId, film.poster,
        `${film.mediaType === 'show' ? '📺' : '🎬'} <b>${escapeHtml(film.title)}</b>${film.year ? ' (' + film.year + ')' : ''}`,
      );
    }

    // Build details + single confirm button. Quality is the host-wide default.
    const typeIcon = film.mediaType === 'show' ? '📺' : '🎬';
    let detailText = `${typeIcon} <b>${escapeHtml(film.title)}</b>${film.year ? ' (' + film.year + ')' : ''}\n`;
    if (film.rating) detailText += `⭐ ${escapeHtml(String(film.rating))}/10`;
    if (film.genre) detailText += ` · ${escapeHtml(film.genre)}`;
    if (film.rating || film.genre) detailText += '\n';
    if (film.plot) detailText += `\n<i>${escapeHtml(film.plot)}</i>\n`;
    detailText += '\nSoll ich den holen?';

    const keyboard = [
      [{ text: '✅ Ja, bitte!', callback_data: `confirm:${index}` }],
      [{ text: '🔙 Andere Auswahl', callback_data: 'back_to_results' }],
    ];
    await editMessage(chatId, messageId, detailText, keyboard);
    return;
  }

  // Back to results
  if (data === 'back_to_results') {
    const session = searchSessions.get(chatId);
    if (!session || Date.now() >= session.expires) {
      await answerCallbackQuery(callbackQueryId, 'Auswahl abgelaufen');
      await editMessage(chatId, messageId, '⏰ Das ist zu lange her — schreib mir den Titel einfach nochmal.');
      return;
    }

    await answerCallbackQuery(callbackQueryId);
    const keyboard = session.results.map((r, i) => ([
      { text: `${r.mediaType === 'show' ? '📺' : '🎬'} ${r.title}${r.year ? ' (' + r.year + ')' : ''}`, callback_data: `select:${i}` }
    ]));
    keyboard.push([{ text: '❌ Doch nicht', callback_data: 'cancel' }]);
    await editMessage(chatId, messageId, '🎬 <b>Welchen meinst du?</b>', keyboard);
    return;
  }

  // Confirm add — uses the host-wide quality setting, no per-request picker.
  if (data.startsWith('confirm:')) {
    if (!canMutate(chatId)) { await denyMutation(chatId, callbackQueryId); return; }
    const index = parseInt(data.substring(8), 10);
    const session = searchSessions.get(chatId);
    if (!session || Date.now() >= session.expires) {
      await answerCallbackQuery(callbackQueryId, 'Auswahl abgelaufen');
      await editMessage(chatId, messageId, '⏰ Das ist zu lange her — schreib mir den Titel einfach nochmal.');
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= session.results.length) {
      await answerCallbackQuery(callbackQueryId, 'Ungueltige Auswahl');
      return;
    }

    const film = session.results[index];
    searchSessions.delete(chatId);
    await answerCallbackQuery(callbackQueryId, 'Alles klar!');

    await handleSelection(chatId, messageId, film);
    return;
  }

  await answerCallbackQuery(callbackQueryId);
}

// ── Selection / Add to Queue ──────────────────────────────────────────────────

async function handleSelection(
  chatId: number,
  messageId: number,
  film: FilmResult,
): Promise<void> {
  // Check if already in queue / known to the system
  const allMovies = getAllMovies();
  const existing = allMovies.find(m =>
    normalizeTitle(m.title) === normalizeTitle(film.title) && m.year === film.year
  ) || (film.imdbId ? getMovieByImdbId(film.imdbId) : null);

  if (existing) {
    await editMessage(chatId, messageId, alreadyKnownMessage(existing), alreadyKnownKeyboard(existing));
    if (existing.id) trackRequester(chatId, existing.title, existing.year ?? 0, existing.id);
    return;
  }

  // Check if already in media library (movies only — provider lookup is movie-shaped)
  if (film.mediaType === 'movie') {
    try {
      const { getLibraryProvider } = await import('./libraryProvider');
      const libraryProvider = getLibraryProvider();
      if (libraryProvider.isConfigured()) {
        const inLibrary = await libraryProvider.hasMovie(film.imdbId, null, film.title, film.year);
        if (inLibrary) {
          await editMessage(chatId, messageId,
            `✅ <b>${escapeHtml(film.title)}</b>${film.year ? ' (' + film.year + ')' : ''} liegt schon auf dem Server — viel Spass beim Schauen!`,
            watchNowKeyboard(),
          );
          return;
        }
      }
    } catch {}
  }

  // Add to queue
  const quality = getSetting('quality.minimum') || '1080p';
  const typeIcon = film.mediaType === 'show' ? '📺' : '🎬';
  try {
    let { movie: inserted } = await requestTitle({
      trakt_id: null,
      imdb_id: film.imdbId || '',
      tmdb_id: null,
      title: film.title,
      year: film.year || null,
      slug: slugify(film.title),
      media_type: film.mediaType,
      status: 'pending',
      desired_quality: quality,
    });

    // Plugin search candidates often carry no imdb id; without one the queue card
    // and dashboard shelf show no poster (/api/poster needs it) and metadata never
    // backfills. Resolve it now from OMDb by title+year so the poster appears at
    // once instead of waiting for the next full sync. Best-effort.
    if (inserted && !inserted.imdb_id) {
      try {
        const { resolveMovieImdbId } = await import('./metadata');
        inserted = await resolveMovieImdbId(inserted);
      } catch { /* best-effort — sync backfill will retry */ }
    }

    trackRequester(chatId, film.title, film.year, inserted?.id);
    addLogEntry(inserted?.id ?? null, 'movie_added', `Telegram: ${film.title}${film.year ? ' (' + film.year + ')' : ''} [${film.mediaType}]`);
    eventBus.emit('movie:updated', { title: film.title });

    // The just-edited message becomes the live progress tracker — one message,
    // not two. The progress listener will edit it again as state advances.
    await editMessage(chatId, messageId,
      `${typeIcon} <b>${escapeHtml(film.title)}</b>${film.year ? ' (' + film.year + ')' : ''}\n🔍 Ich schau mich um...`
    );
    trackProgress(chatId, messageId, film.title, film.year);

    logger.info(`Telegram: ${film.mediaType} requested - ${film.title} (${film.year || '—'}) by chat ${chatId}`);

    // Trigger immediate search in background (don't block the Telegram response)
    triggerImmediateProcessing(film.title, film.year, chatId);
  } catch (error: any) {
    logger.error(`Telegram: failed to add movie: ${error.message}`);
    await editMessage(chatId, messageId, '❌ Ups — ich konnte den nicht auf die Liste setzen. Probier es bitte gleich nochmal.');
  }
}

/**
 * Inline keyboard with a "Jetzt schauen" link button, shown on download-done
 * notifications and "already-in-library" replies when library.public_url is
 * configured. Returns undefined if no URL is set so callers can skip the keyboard.
 */
function watchNowKeyboard(): any[][] | undefined {
  const url = (getSetting('library.public_url') || '').trim();
  if (!url) return undefined;
  return [[{ text: '🎬 Jetzt schauen', url }]];
}

// ── Telegram Notifications (called from other services) ───────────────────────

/**
 * Send a notification to all allowed Telegram chats.
 * Used by postprocess/scheduler to inform users about download events.
 */
export async function sendTelegramNotification(
  event: 'download_complete' | 'download_started' | 'error',
  title: string,
  year: number,
  message: string,
  imdbId?: string | null
): Promise<void> {
  if (!isConfigured()) return;

  const icons = {
    download_complete: '✅',
    download_started: '⬇️',
    error: '❌',
  };
  const icon = icons[event] || 'ℹ️';
  const text = `${icon} <b>${escapeHtml(title)}</b> (${year})\n${message}`;

  // For download_complete, try to fetch a poster for a rich notification
  let posterUrl: string | null = null;
  if (event === 'download_complete') {
    try {
      const details = await fetchMovieDetails(title, year, imdbId);
      posterUrl = details.poster;
    } catch {}
  }

  const keyboard = event === 'download_complete' ? watchNowKeyboard() : undefined;
  const notify = async (chatId: number): Promise<void> => {
    if (posterUrl && event === 'download_complete') {
      const sent = await sendPhoto(chatId, posterUrl, text, keyboard);
      // Fall back to plain text (with keyboard) if photo send failed
      if (!sent) {
        if (keyboard) await sendMessageWithKeyboard(chatId, text, keyboard);
        else await sendMessage(chatId, text);
      }
    } else if (keyboard) {
      await sendMessageWithKeyboard(chatId, text, keyboard);
    } else {
      await sendMessage(chatId, text);
    }
  };

  // Notify requesters of this specific movie first
  const requesters = getRequesters(title, year);
  const notified = new Set<number>();

  for (const chatId of requesters) {
    try {
      await notify(chatId);
      notified.add(chatId);
    } catch (err: any) {
      logger.warn(`Telegram notification failed for chat ${chatId}: ${err.message}`);
    }
  }

  // If no specific requesters, notify all allowed chat IDs
  if (notified.size === 0) {
    const allowedIds = getSetting('telegram.allowed_chat_ids');
    if (allowedIds) {
      const ids = allowedIds.split(',').map(s => s.trim()).filter(Boolean);
      for (const id of ids) {
        const chatId = parseInt(id);
        if (!isNaN(chatId) && !notified.has(chatId)) {
          try { await notify(chatId); } catch (err: any) {
            logger.warn(`Telegram notification failed for chat ${chatId}: ${err.message}`);
          }
        }
      }
    }
  }

  // Clean up requesters + live-progress tracking for completed downloads
  if (event === 'download_complete') {
    const key = `${title.toLowerCase()}|${year}`;
    movieRequesters.delete(key);
    progressMessages.delete(key);
  }
}

/**
 * Tell the people who requested a movie that we've genuinely given up on it
 * (the scheduler hit MAX_RETRIES — every source exhausted over days of backoff).
 * Called from the scheduler's max-retries guard, which fires every tick for an
 * exhausted item, so this is strictly once-only per movie (persisted set) until
 * the user taps "retry". Routes via the persisted /meine reverse index so it
 * still reaches the right person after a restart, with the in-session requester
 * map as a fallback. Stays silent if nobody asked — no broadcast spam.
 */
export async function notifyGaveUp(
  movie: { id: number; title: string; year: number | null; media_type?: MediaType; status?: string },
): Promise<void> {
  if (!isConfigured()) return;
  if (gaveUpNotified.has(movie.id)) return;
  // Don't claim we gave up on something that actually landed (or is mid-flight).
  // A show can hit max retries while already 'downloaded' — just hunting for new
  // episodes — and telling the requester "couldn't load it" would be wrong.
  if (movie.status === 'downloaded' || movie.status === 'downloading') return;

  const chats = new Set<number>();
  for (const [chatId, ids] of chatRequests) if (ids.has(movie.id)) chats.add(chatId);
  for (const c of getRequesters(movie.title, movie.year ?? 0)) chats.add(c);
  if (chats.size === 0) return; // nobody to tell — a requester may still surface later

  gaveUpNotified.add(movie.id);
  persistGaveUpNotified();
  addLogEntry(movie.id, 'telegram_gave_up', `Telegram: gave up after max retries — ${movie.title}`);
  // Drop any stale live-progress entry so the old "Lade gerade runter..." line stops.
  progressMessages.delete(`${movie.title.toLowerCase()}|${movie.year ?? 0}`);

  const typeIcon = movie.media_type === 'show' ? '📺' : '🎬';
  const text = `😕 ${typeIcon} <b>${escapeHtml(movie.title)}</b>${movie.year ? ' (' + movie.year + ')' : ''}\n`
    + 'Ich hab\'s mehrfach versucht, konnte ihn aber nicht laden — vielleicht ist er noch nicht (gut) verfügbar.';
  for (const chatId of chats) {
    try {
      await sendMessageWithKeyboard(chatId, text, retryKeyboard(movie.id));
    } catch (err: any) {
      logger.warn(`Telegram give-up notification failed for chat ${chatId}: ${err.message}`);
    }
  }
}

/**
 * System-wide alert (health monitor, deploy failures, etc.) — broadcasts to all
 * configured allowed_chat_ids. Unlike sendTelegramNotification this is not tied
 * to a specific movie, so there's no per-requester routing.
 */
export async function sendTelegramSystemAlert(text: string): Promise<void> {
  if (!isConfigured()) return;

  const allowedIds = getSetting('telegram.allowed_chat_ids');
  if (!allowedIds) return;

  const ids = allowedIds.split(',').map(s => s.trim()).filter(Boolean);
  for (const id of ids) {
    const chatId = parseInt(id);
    if (!isNaN(chatId)) {
      try { await sendMessage(chatId, text); } catch (err: any) {
        logger.warn(`Telegram system alert failed for chat ${chatId}: ${err.message}`);
      }
    }
  }
}

// ── Immediate Processing ──────────────────────────────────────────────────────

/**
 * Trigger immediate search/download for a movie added via Telegram.
 * Runs in background — does not block the Telegram response.
 */
function triggerImmediateProcessing(title: string, year: number, chatId: number): void {
  logger.info(`Telegram: triggerImmediateProcessing called for "${title}" (${year})`);
  (async () => {
    try {
      // Lazy-import to avoid circular dependency
      const { processMovie, processingMovies } = await import('./scheduler');
      const movies = getMoviesByStatus('pending');
      logger.info(`Telegram: immediate search — ${movies.length} pending movie(s), looking for "${title}" (${year})`);
      // Normalize "no year" on both sides: a year-less add stores year=NULL but
      // callers pass 0/undefined here, so a strict `m.year === year` (null === 0)
      // never matches and the immediate search silently no-ops. `|| null`
      // collapses 0/undefined/null to null while leaving real years intact.
      const wantYear = year || null;
      const movie = movies.find(m => m.title.toLowerCase() === title.toLowerCase() && (m.year || null) === wantYear);
      if (!movie) {
        logger.warn(`Telegram: immediate search — "${title}" (${year}) not found in pending movies`);
        return;
      }
      if (processingMovies.has(movie.id)) {
        logger.info(`Telegram: immediate search — "${title}" already being processed`);
        return;
      }

      logger.info(`Telegram: triggering immediate search for ${title} (${year})`);
      await processMovie(movie);
    } catch (error: any) {
      logger.error(`Telegram: immediate processing failed for ${title}: ${error.message}`);
    }
  })();
}

// ── Poll Loop ─────────────────────────────────────────────────────────────────

async function pollLoop(): Promise<void> {
  while (pollActive) {
    if (!isConfigured()) {
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    try {
      pollCancelSource = axios.CancelToken.source();
      const res = await axios.get(`${TELEGRAM_API}${getToken()}/getUpdates`, {
        params: {
          offset: lastUpdateId + 1,
          timeout: 30,
          allowed_updates: JSON.stringify(['message', 'callback_query']),
        },
        timeout: 35000,
        cancelToken: pollCancelSource.token,
      });

      const updates = res.data?.result || [];
      for (const update of updates) {
        lastUpdateId = update.update_id;

        // Isolate each update: a throw in one handler must not abandon the rest of
        // the batch. The offset has already advanced past this update, so we never
        // reprocess it (no poison-message lockup) — we log and move on, and the
        // remaining updates in the batch still get handled.
        try {
          // Handle callback queries (inline keyboard button presses)
          const cb = update.callback_query;
          if (cb?.data && cb?.message?.chat?.id) {
            const cbChatId = cb.message.chat.id;
            if (!isChatAllowed(cbChatId)) {
              await handleUnauthorized(cbChatId, cb.from, cb.id);
              continue;
            }
            await handleCallback(cbChatId, cb.message.message_id, cb.id, cb.data);
            continue;
          }

          // Handle text messages
          const msg = update.message;
          if (msg?.text && msg?.chat?.id) {
            if (!isChatAllowed(msg.chat.id)) {
              await handleUnauthorized(msg.chat.id, msg.from);
              continue;
            }
            await handleMessage(msg.chat.id, msg.text);
          }
        } catch (err: any) {
          logger.error(`Telegram update ${update.update_id} handling failed: ${err?.message || err}`);
        }
      }
    } catch (error: any) {
      if (axios.isCancel(error)) break; // Cancelled by stopTelegramBot — exit cleanly
      const status = error.response?.status;
      if (status === 429) {
        // 429 = rate limited — back off for the duration Telegram specifies
        const retryAfter = error.response?.data?.parameters?.retry_after ?? 10;
        logger.warn(`Telegram rate limited (429) — backing off ${retryAfter}s`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
      } else if (status === 409) {
        // 409 = another getUpdates is active — back off longer and retry
        logger.warn('Telegram poll conflict (409) — backing off 30s');
        await new Promise(r => setTimeout(r, 30000));
      } else if (!error.message?.includes('timeout') && !error.message?.includes('ECONNRESET')) {
        logger.error(`Telegram poll error: ${error.message}`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        // Long-poll timeout / ECONNRESET: normal on a transient blip, but pause
        // briefly so a sustained outage (especially an immediate ECONNRESET that
        // returns with no delay) can't spin the loop at full speed.
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
}

export async function startTelegramBot(): Promise<void> {
  stopTelegramBot();
  if (!isConfigured()) {
    logger.debug('Telegram bot not configured - skipping');
    return;
  }

  // Delete any existing webhook and flush pending updates
  try {
    await axios.post(`${TELEGRAM_API}${getToken()}/deleteWebhook`, {
      drop_pending_updates: true,
    }, { timeout: 10000 });
  } catch {}

  // Register bot commands so they appear in Telegram's / menu
  await registerCommands();

  const allowedIds = getSetting('telegram.allowed_chat_ids');
  if (!allowedIds) {
    logger.warn('Telegram bot started WITHOUT chat ID restriction — anyone who finds the bot can add downloads. Set telegram.allowed_chat_ids to restrict access.');
  } else {
    logger.info('Telegram bot started (restricted to chat IDs: ' + allowedIds + ')');
  }
  // Restore persisted user state (greeted chats, /meine reverse index,
  // pending access requests, and which give-up notices already went out)
  loadGreetedChats();
  loadChatRequests();
  loadAccessRequested();
  loadGaveUpNotified();

  pollActive = true;
  startSessionCleanup();
  setupProgressListener();
  pollLoop();
}

export function stopTelegramBot(): void {
  pollActive = false;
  if (pollCancelSource) {
    pollCancelSource.cancel('Bot restarting');
    pollCancelSource = null;
  }
  stopSessionCleanup();
  cleanupProgressListener();
  searchSessions.clear();
}

export async function testTelegramBot(): Promise<{ success: boolean; botName?: string; error?: string }> {
  const token = getToken();
  if (!token) return { success: false, error: 'Kein Bot-Token konfiguriert' };

  try {
    const res = await axios.get(`${TELEGRAM_API}${token}/getMe`, { timeout: 10000 });
    if (res.data?.ok) {
      return { success: true, botName: res.data.result.username };
    }
    return { success: false, error: 'Ungueltige Antwort von Telegram' };
  } catch (error: any) {
    return { success: false, error: error.response?.data?.description || error.message };
  }
}

export const telegramBot = { isConfigured, startTelegramBot, stopTelegramBot, testTelegramBot };
