import axios, { CancelTokenSource } from 'axios';
import { getSetting } from '../database/index';
import { addMovie, getMovieByTmdbId, getMovieByImdbId, getAllMovies, getMoviesByStatus } from '../database/services/movies';
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

// Track progress messages: "title|year" -> { chatId, messageId } for live status updates
const progressMessages = new Map<string, { chatId: number; messageId: number }>();

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

function getToken(): string {
  return getSetting('telegram.bot_token') || '';
}

function isConfigured(): boolean {
  return !!getToken() && getSetting('telegram.enabled') === 'true';
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
        { command: 'start', description: 'Bot starten' },
        { command: 'status', description: 'Aktuelle Downloads anzeigen' },
        { command: 'list', description: 'Zuletzt hinzugefuegte Filme' },
        { command: 'add', description: 'Film manuell hinzufuegen' },
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
      searching: '🔍 Wird gesucht...',
      found: '📦 Release gefunden!',
      downloading: '⬇️ Download gestartet',
      not_found: '❌ Nicht gefunden',
    };

    const msg = statusMessages[data.status];
    if (!msg) return;

    try {
      await editMessage(entry.chatId, entry.messageId,
        `<b>${data.title}</b>\n${msg}`
      );
    } catch {}

    // Stop tracking on terminal states
    if (['downloading', 'not_found'].includes(data.status) && matchKey) {
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

function trackRequester(chatId: number, title: string, year: number): void {
  const key = `${title.toLowerCase()}|${year}`;
  let entry = movieRequesters.get(key);
  if (!entry) {
    entry = { chatIds: new Set(), lastTouched: Date.now() };
    movieRequesters.set(key, entry);
  } else {
    entry.lastTouched = Date.now();
  }
  entry.chatIds.add(chatId);
}

function getRequesters(title: string, year: number): Set<number> {
  const key = `${title.toLowerCase()}|${year}`;
  return movieRequesters.get(key)?.chatIds ?? new Set();
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function handleMessage(chatId: number, text: string): Promise<void> {
  const trimmed = text.trim();

  // /start command
  if (trimmed === '/start') {
    await sendMessage(chatId,
      '🎬 <b>Film-Bot</b>\n\n' +
      'Schick mir einfach einen Filmnamen und ich suche ihn fuer dich!\n\n' +
      'Beispiel: <i>Resident Evil</i>\n\n' +
      '<b>Befehle:</b>\n' +
      '/status — Aktuelle Downloads\n' +
      '/list — Zuletzt hinzugefuegt\n' +
      '/add Filmname — Film manuell hinzufuegen'
    );
    return;
  }

  // /add command — manually add a movie by title
  if (trimmed.startsWith('/add ')) {
    const movieTitle = trimmed.substring(5).trim();
    if (!movieTitle) {
      await sendMessage(chatId, 'Bitte einen Filmnamen angeben: <b>/add Filmname</b>');
      return;
    }

    const allMovies = getAllMovies();
    const existing = allMovies.find(m => normalizeTitle(m.title) === normalizeTitle(movieTitle));
    if (existing) {
      await sendMessage(chatId, `ℹ️ <b>${existing.title}</b> (${existing.year}) ist bereits in der Warteschlange.`);
      return;
    }

    const minQuality = getSetting('quality.minimum') || '1080p';
    addMovie({
      trakt_id: null as any,
      imdb_id: '',
      tmdb_id: null,
      title: movieTitle,
      year: new Date().getFullYear(),
      slug: movieTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      media_type: 'movie',
      status: 'pending',
      desired_quality: minQuality,
    });

    trackRequester(chatId, movieTitle, new Date().getFullYear());
    addLogEntry(null, 'movie_added', `Telegram (manuell): ${movieTitle}`);
    eventBus.emit('movie:updated', { title: movieTitle });

    await sendMessage(chatId,
      `✅ <b>${movieTitle}</b> wurde in die Warteschlange gesetzt.`
    );

    // Send progress tracking message
    const addProgressMsgId = await sendMessageReturningId(chatId,
      `<b>${movieTitle}</b>\n🔍 Suche wird gestartet...`
    );
    if (addProgressMsgId) trackProgress(chatId, addProgressMsgId, movieTitle, new Date().getFullYear());

    logger.info(`Telegram: manual add - ${movieTitle} by chat ${chatId}`);

    // Trigger immediate search in background
    triggerImmediateProcessing(movieTitle, new Date().getFullYear(), chatId);
    return;
  }

  // /status command
  if (trimmed === '/status') {
    const movies = getAllMovies();
    const pending = movies.filter(m => m.status === 'pending');
    const downloading = movies.filter(m => m.status === 'downloading');
    const downloaded = movies.filter(m => m.status === 'downloaded');
    const notFound = movies.filter(m => m.status === 'not_found');

    let msg = '📊 <b>Status</b>\n\n' +
      `⏳ Warteschlange: ${pending.length}\n` +
      `⬇️ Wird geladen: ${downloading.length}\n` +
      `✅ Fertig: ${downloaded.length}\n` +
      `❌ Nicht gefunden: ${notFound.length}\n` +
      `📦 Gesamt: ${movies.length}`;

    if (downloading.length > 0) {
      msg += '\n\n<b>Aktive Downloads:</b>';
      for (const m of downloading.slice(0, 5)) {
        msg += `\n⬇️ ${m.title} (${m.year})`;
      }
      if (downloading.length > 5) msg += `\n<i>...und ${downloading.length - 5} weitere</i>`;
    }

    await sendMessage(chatId, msg);
    return;
  }

  // /list command — show recently added movies
  if (trimmed === '/list') {
    const movies = getAllMovies();
    const recent = movies
      .sort((a, b) => (b.id || 0) - (a.id || 0))
      .slice(0, 10);

    if (recent.length === 0) {
      await sendMessage(chatId, 'Noch keine Filme in der Warteschlange.');
      return;
    }

    const statusIcons: Record<string, string> = {
      pending: '⏳',
      searching: '🔍',
      found: '📦',
      downloading: '⬇️',
      downloaded: '✅',
      not_found: '❌',
    };

    let msg = '📋 <b>Letzte 10 Filme:</b>\n';
    for (const m of recent) {
      const icon = statusIcons[m.status] || '❓';
      msg += `\n${icon} ${m.title} (${m.year})`;
    }

    await sendMessage(chatId, msg);
    return;
  }

  // Search for movie — aggregate plugin candidates, fall back to OMDb
  try {
    await sendChatAction(chatId, 'typing');
    await sendMessage(chatId, `🔍 Suche "<b>${trimmed}</b>"...`);

    // 1. Try registered plugins that expose title search
    let resultList: FilmResult[] = [];
    try {
      const hits = await pluginRegistry.aggregateSearchTitles(trimmed, { mediaType: 'movie', limit: 5 });
      // Dedupe by lowercased title+year — different plugins may surface the same film
      const seen = new Set<string>();
      resultList = hits
        .sort((a, b) => scoreSearchResult(b.title, trimmed) - scoreSearchResult(a.title, trimmed))
        .filter(h => {
          const key = `${h.title.toLowerCase()}|${h.year || ''}`;
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
        }));
    } catch (pluginErr: any) {
      logger.debug(`Telegram: plugin title search failed: ${pluginErr.message}`);
    }

    // 2. Fallback: OMDb (if no plugin returned candidates)
    if (resultList.length === 0) {
      const omdbKey = getSetting('omdb.api_key');
      if (omdbKey) {
        try {
          const omdbRes = await axios.get(`https://www.omdbapi.com/`, {
            params: { apikey: omdbKey, s: trimmed, type: 'movie' },
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
          }));
          if (resultList.length > 0) {
            logger.info(`Telegram: no plugin candidates, OMDb found ${resultList.length} for "${trimmed}"`);
          }
        } catch (e: any) {
          logger.debug(`OMDb search failed: ${e.message}`);
        }
      }
    }

    if (resultList.length === 0) {
      const notFoundMsg = `Kein Film gefunden fuer "<b>${trimmed}</b>".\n\nDer Film ist vielleicht noch nicht erschienen.`;
      await sendMessageWithKeyboard(chatId, notFoundMsg,
        [[{ text: '📝 Trotzdem hinzufuegen', callback_data: `add_manual:${trimmed}` }]]
      );
      return;
    }

    // Save session (expires in 15 minutes)
    searchSessions.set(chatId, { results: resultList, expires: Date.now() + 15 * 60 * 1000 });

    // Build inline keyboard — one button per result
    const keyboard = resultList.map((r, i) => ([
      { text: `${r.title} (${r.year})`, callback_data: `select:${i}` }
    ]));
    keyboard.push([{ text: '❌ Abbrechen', callback_data: 'cancel' }]);

    await sendMessageWithKeyboard(chatId, '🎬 <b>Ergebnisse:</b>', keyboard);
  } catch (error: any) {
    logger.error(`Telegram search failed: ${error.message}`);
    await sendMessage(chatId, '❌ Suche fehlgeschlagen. Bitte spaeter nochmal versuchen.');
  }
}

// ── Callback Handling (Inline Keyboard) ───────────────────────────────────────

async function handleCallback(chatId: number, messageId: number, callbackQueryId: string, data: string): Promise<void> {
  // Cancel button
  if (data === 'cancel') {
    searchSessions.delete(chatId);
    await answerCallbackQuery(callbackQueryId);
    await editMessage(chatId, messageId, '🚫 Suche abgebrochen.');
    return;
  }

  // Manual add from "not found" screen
  if (data.startsWith('add_manual:')) {
    const movieTitle = data.substring(11);
    await answerCallbackQuery(callbackQueryId, 'Wird hinzugefuegt...');
    await editMessage(chatId, messageId, `⏳ <b>${movieTitle}</b> wird hinzugefuegt...`);

    const allMovies = getAllMovies();
    const existing = allMovies.find(m => normalizeTitle(m.title) === normalizeTitle(movieTitle));
    if (existing) {
      await editMessage(chatId, messageId, `ℹ️ <b>${existing.title}</b> (${existing.year}) ist bereits in der Warteschlange.`);
      return;
    }

    const minQuality = getSetting('quality.minimum') || '1080p';
    const year = new Date().getFullYear();
    addMovie({
      trakt_id: null as any, imdb_id: '', tmdb_id: null,
      title: movieTitle, year,
      slug: movieTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      media_type: 'movie', status: 'pending', desired_quality: minQuality,
    });
    trackRequester(chatId, movieTitle, year);
    addLogEntry(null, 'movie_added', `Telegram (manuell): ${movieTitle}`);
    eventBus.emit('movie:updated', { title: movieTitle });

    await editMessage(chatId, messageId,
      `✅ <b>${movieTitle}</b> wurde in die Warteschlange gesetzt.`);

    // Send progress tracking message
    const manualProgressMsgId = await sendMessageReturningId(chatId,
      `<b>${movieTitle}</b>\n🔍 Suche wird gestartet...`
    );
    if (manualProgressMsgId) trackProgress(chatId, manualProgressMsgId, movieTitle, year);

    logger.info(`Telegram: manual add - ${movieTitle} by chat ${chatId}`);

    // Trigger immediate search in background
    triggerImmediateProcessing(movieTitle, year, chatId);
    return;
  }

  // Select a search result → show confirmation
  if (data.startsWith('select:')) {
    const index = parseInt(data.substring(7));
    const session = searchSessions.get(chatId);
    if (!session || Date.now() >= session.expires) {
      await answerCallbackQuery(callbackQueryId, 'Session abgelaufen');
      await editMessage(chatId, messageId, '⏰ Die Suche ist abgelaufen. Bitte erneut suchen.');
      return;
    }
    if (index < 0 || index >= session.results.length) {
      await answerCallbackQuery(callbackQueryId, 'Ungueltige Auswahl');
      return;
    }

    const film = session.results[index];
    await answerCallbackQuery(callbackQueryId);
    await editMessage(chatId, messageId, '⏳ Lade Details...');

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
      await sendPhoto(chatId, film.poster, `🎬 <b>${film.title}</b> (${film.year})`);
    }

    // Build rich confirmation text
    let detailText = `🎬 <b>${film.title}</b> (${film.year})\n`;
    if (film.rating) detailText += `⭐ ${film.rating}/10`;
    if (film.genre) detailText += ` · ${film.genre}`;
    if (film.rating || film.genre) detailText += '\n';
    if (film.plot) detailText += `\n<i>${film.plot}</i>\n`;
    if (film.imdbId) detailText += `\n🔗 <a href="https://www.imdb.com/title/${film.imdbId}/">IMDb</a>\n`;
    detailText += '\nHinzufuegen?';

    const keyboard = [
      [{ text: '✅ Hinzufuegen', callback_data: `confirm:${index}` }],
      [{ text: '🔙 Zurueck', callback_data: 'back_to_results' }],
    ];
    await editMessage(chatId, messageId, detailText, keyboard);
    return;
  }

  // Back to results
  if (data === 'back_to_results') {
    const session = searchSessions.get(chatId);
    if (!session || Date.now() >= session.expires) {
      await answerCallbackQuery(callbackQueryId, 'Session abgelaufen');
      await editMessage(chatId, messageId, '⏰ Die Suche ist abgelaufen. Bitte erneut suchen.');
      return;
    }

    await answerCallbackQuery(callbackQueryId);
    const keyboard = session.results.map((r, i) => ([
      { text: `${r.title} (${r.year})`, callback_data: `select:${i}` }
    ]));
    keyboard.push([{ text: '❌ Abbrechen', callback_data: 'cancel' }]);
    await editMessage(chatId, messageId, '🎬 <b>Ergebnisse:</b>', keyboard);
    return;
  }

  // Confirm add
  if (data.startsWith('confirm:')) {
    const index = parseInt(data.substring(8));
    const session = searchSessions.get(chatId);
    if (!session || Date.now() >= session.expires) {
      await answerCallbackQuery(callbackQueryId, 'Session abgelaufen');
      await editMessage(chatId, messageId, '⏰ Die Suche ist abgelaufen. Bitte erneut suchen.');
      return;
    }
    if (index < 0 || index >= session.results.length) {
      await answerCallbackQuery(callbackQueryId, 'Ungueltige Auswahl');
      return;
    }

    const film = session.results[index];
    searchSessions.delete(chatId);
    await answerCallbackQuery(callbackQueryId, 'Wird hinzugefuegt...');

    await handleSelection(chatId, messageId, film);
    return;
  }

  await answerCallbackQuery(callbackQueryId);
}

// ── Selection / Add to Queue ──────────────────────────────────────────────────

async function handleSelection(chatId: number, messageId: number, film: FilmResult): Promise<void> {
  // Check if already in queue
  const allMovies = getAllMovies();
  const existing = allMovies.find(m =>
    normalizeTitle(m.title) === normalizeTitle(film.title) && m.year === film.year
  ) || (film.imdbId ? getMovieByImdbId(film.imdbId) : null);

  if (existing) {
    const statusLabels: Record<string, string> = {
      pending: '⏳ in der Warteschlange',
      searching: '🔍 wird gesucht',
      found: '📦 gefunden',
      downloading: '⬇️ wird geladen',
      downloaded: '✅ bereits heruntergeladen',
      not_found: '❌ nicht gefunden',
    };
    const status = statusLabels[existing.status] || existing.status;
    await editMessage(chatId, messageId,
      `ℹ️ <b>${film.title}</b> (${film.year}) ist bereits ${status}.`
    );
    return;
  }

  // Check if already in media library
  try {
    const { getLibraryProvider, getLibraryProviderName } = await import('./libraryProvider');
    const libraryProvider = getLibraryProvider();
    if (libraryProvider.isConfigured()) {
      const inLibrary = await libraryProvider.hasMovie(film.imdbId, null, film.title, film.year);
      if (inLibrary) {
        const providerName = getLibraryProviderName();
        await editMessage(chatId, messageId,
          `✅ <b>${film.title}</b> (${film.year}) ist bereits in der ${providerName}-Bibliothek!`
        );
        return;
      }
    }
  } catch {}

  // Add to queue
  const minQuality = getSetting('quality.minimum') || '1080p';
  try {
    addMovie({
      trakt_id: null as any,
      imdb_id: film.imdbId || '',
      tmdb_id: null,
      title: film.title,
      year: film.year,
      slug: slugify(film.title),
      media_type: 'movie',
      status: 'pending',
      desired_quality: minQuality,
    });

    trackRequester(chatId, film.title, film.year);
    addLogEntry(null, 'movie_added', `Telegram: ${film.title} (${film.year})`);
    eventBus.emit('movie:updated', { title: film.title });

    await editMessage(chatId, messageId,
      `✅ <b>${film.title}</b> (${film.year}) hinzugefuegt!`
    );

    // Send progress tracking message
    const progressMsgId = await sendMessageReturningId(chatId,
      `<b>${film.title}</b> (${film.year})\n🔍 Suche wird gestartet...`
    );
    if (progressMsgId) trackProgress(chatId, progressMsgId, film.title, film.year);

    logger.info(`Telegram: movie requested - ${film.title} (${film.year}) by chat ${chatId}`);

    // Trigger immediate search in background (don't block the Telegram response)
    triggerImmediateProcessing(film.title, film.year, chatId);
  } catch (error: any) {
    logger.error(`Telegram: failed to add movie: ${error.message}`);
    await editMessage(chatId, messageId, '❌ Film konnte nicht hinzugefuegt werden.');
  }
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
  const text = `${icon} <b>${title}</b> (${year})\n${message}`;

  // For download_complete, try to fetch a poster for a rich notification
  let posterUrl: string | null = null;
  if (event === 'download_complete') {
    try {
      const details = await fetchMovieDetails(title, year, imdbId);
      posterUrl = details.poster;
    } catch {}
  }

  const notify = async (chatId: number): Promise<void> => {
    if (posterUrl && event === 'download_complete') {
      const sent = await sendPhoto(chatId, posterUrl, text);
      // Fall back to plain text if photo send failed
      if (!sent) await sendMessage(chatId, text);
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

  // Clean up requesters for completed downloads
  if (event === 'download_complete') {
    const key = `${title.toLowerCase()}|${year}`;
    movieRequesters.delete(key);
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
      const movie = movies.find(m => m.title.toLowerCase() === title.toLowerCase() && m.year === year);
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

        // Handle callback queries (inline keyboard button presses)
        const cb = update.callback_query;
        if (cb?.data && cb?.message?.chat?.id) {
          const cbChatId = cb.message.chat.id;
          if (!isChatAllowed(cbChatId)) continue;
          await handleCallback(cbChatId, cb.message.message_id, cb.id, cb.data);
          continue;
        }

        // Handle text messages
        const msg = update.message;
        if (msg?.text && msg?.chat?.id) {
          if (!isChatAllowed(msg.chat.id)) {
            logger.debug(`Telegram: ignoring message from unauthorized chat ${msg.chat.id}`);
            continue;
          }
          await handleMessage(msg.chat.id, msg.text);
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
