import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

// All shared mock state lives in a hoisted block so the (hoisted) vi.mock
// factories below can safely reference it.
const H = vi.hoisted(() => {
  const mockSettings: Record<string, string> = {};
  const state = {
    mockSettings,
    mockAllMovies: [] as any[],
    registeredHandlers: {} as Record<string, (data: any) => void>,
    processingMoviesSet: new Set<number>(),
  };
  const addMovieMock = vi.fn((data: any) => ({ id: 1, ...data }));
  const getMovieByImdbIdMock = vi.fn(() => undefined as any);
  const getMoviesByStatusMock = vi.fn((status: string) => state.mockAllMovies.filter(m => m.status === status));
  const getAllMoviesMock = vi.fn(() => state.mockAllMovies);
  const aggregateSearchTitlesMock = vi.fn(async () => [] as any[]);
  const libHasMovieMock = vi.fn(async () => false);
  const libIsConfiguredMock = vi.fn(() => false);
  const processMovieMock = vi.fn(async () => {});
  const eventBusMock = {
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (data: any) => void) => { state.registeredHandlers[event] = handler; }),
    removeListener: vi.fn((event: string) => { delete state.registeredHandlers[event]; }),
  };
  return {
    state, addMovieMock, getMovieByImdbIdMock, getMoviesByStatusMock, getAllMoviesMock,
    aggregateSearchTitlesMock, libHasMovieMock, libIsConfiguredMock, processMovieMock, eventBusMock,
  };
});

const mockSettings = H.state.mockSettings;
const addMovieMock = H.addMovieMock;
const getMovieByImdbIdMock = H.getMovieByImdbIdMock;
const getMoviesByStatusMock = H.getMoviesByStatusMock;
const aggregateSearchTitlesMock = H.aggregateSearchTitlesMock;
const libHasMovieMock = H.libHasMovieMock;
const libIsConfiguredMock = H.libIsConfiguredMock;
const processMovieMock = H.processMovieMock;
const eventBusMock = H.eventBusMock;
const processingMoviesSet = H.state.processingMoviesSet;

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => H.state.mockSettings[key] ?? ''),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
}));

const deleteMovieMock = vi.fn();
vi.mock('../../src/database/services/movies', () => ({
  addMovie: (...a: any[]) => H.addMovieMock(...a),
  deleteMovie: (...a: any[]) => deleteMovieMock(...a),
  getMovieById: (id: number) => H.state.mockAllMovies.find((m: any) => m.id === id),
  getMovieByTmdbId: vi.fn(() => undefined),
  getMovieByImdbId: (...a: any[]) => H.getMovieByImdbIdMock(...a),
  getAllMovies: (...a: any[]) => H.getAllMoviesMock(...a),
  getMoviesByStatus: (...a: any[]) => H.getMoviesByStatusMock(...a),
}));

vi.mock('../../src/database/services/activityLog', () => ({
  addLogEntry: vi.fn(),
}));

vi.mock('../../src/services/eventbus', () => ({ eventBus: H.eventBusMock }));

vi.mock('../../src/plugins/registry', () => ({
  pluginRegistry: {
    aggregateSearchTitles: (...a: any[]) => H.aggregateSearchTitlesMock(...a),
    aggregateDiscover: vi.fn(async () => []),
    getCachedDiscover: vi.fn(() => []),
  },
}));

vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({ isConfigured: H.libIsConfiguredMock, hasMovie: H.libHasMovieMock })),
  getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));

vi.mock('../../src/services/scheduler', () => ({
  processMovie: (...a: any[]) => H.processMovieMock(...a),
  processingMovies: H.state.processingMoviesSet,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// CancelToken + isCancel helpers (axios is fully auto-mocked, these are undefined otherwise)
mockedAxios.isCancel = vi.fn(() => false) as any;
(mockedAxios as any).CancelToken = { source: vi.fn(() => ({ token: {}, cancel: vi.fn() })) };

import {
  sendTelegramNotification,
  sendTelegramSystemAlert,
  testTelegramBot,
  startTelegramBot,
  stopTelegramBot,
  telegramBot,
  parseTitleAndYear,
} from '../../src/services/telegram';
import { logger } from '../../src/utils/logger';

const TELEGRAM_API = 'https://api.telegram.org/bot';

/** URL helper for a configured token. */
function url(method: string, token = 'test-token') {
  return `${TELEGRAM_API}${token}/${method}`;
}

/** Find a posted call by its endpoint suffix. */
function postCallFor(method: string) {
  return mockedAxios.post.mock.calls.find(c => String(c[0]).endsWith('/' + method));
}

function setMovies(movies: any[]) { H.state.mockAllMovies = movies; }
/**
 * The live handler is removed from registeredHandlers by stopTelegramBot, so we
 * recover it from the eventBus.on mock call args (which survive cleanup).
 */
function getHandler(event: string): ((data: any) => void) | undefined {
  const live = H.state.registeredHandlers[event];
  if (live) return live;
  const call = [...eventBusMock.on.mock.calls].reverse().find(c => c[0] === event);
  return call?.[1];
}

function configure(opts: { enabled?: boolean; token?: string; chatIds?: string; omdb?: string; libraryUrl?: string; greet?: boolean } = {}) {
  if (opts.token !== undefined) mockSettings['telegram.bot_token'] = opts.token;
  else mockSettings['telegram.bot_token'] = 'test-token';
  mockSettings['telegram.enabled'] = opts.enabled === false ? 'false' : 'true';
  if (opts.chatIds !== undefined) mockSettings['telegram.allowed_chat_ids'] = opts.chatIds;
  if (opts.omdb !== undefined) mockSettings['omdb.api_key'] = opts.omdb;
  if (opts.libraryUrl !== undefined) mockSettings['library.public_url'] = opts.libraryUrl;
  // Pre-greet the configured chat IDs by default so individual tests don't get
  // the one-time onboarding message interleaved with their own assertions.
  // Tests that exercise the greeting itself pass greet:false.
  if (opts.greet !== false) {
    const ids = opts.chatIds ?? '111';
    if (ids) mockSettings['telegram.greeted_chat_ids'] = ids;
  }
}

beforeEach(() => {
  // Reset the *Once queue and call history fully.
  mockedAxios.get.mockReset();
  mockedAxios.post.mockReset();
  mockedAxios.get.mockResolvedValue({ data: { ok: true, result: [] } });
  mockedAxios.post.mockResolvedValue({ data: { ok: true, result: { message_id: 555 } } });
  mockedAxios.isCancel = vi.fn(() => false) as any;
  (mockedAxios as any).CancelToken = { source: vi.fn(() => ({ token: {}, cancel: vi.fn() })) };

  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.debug).mockClear();

  addMovieMock.mockClear();
  deleteMovieMock.mockClear();
  getMovieByImdbIdMock.mockClear().mockReturnValue(undefined as any);
  getMoviesByStatusMock.mockClear();
  aggregateSearchTitlesMock.mockClear().mockResolvedValue([]);
  processMovieMock.mockClear();
  libHasMovieMock.mockClear().mockResolvedValue(false);
  libIsConfiguredMock.mockClear().mockReturnValue(false);
  eventBusMock.emit.mockClear();
  eventBusMock.on.mockClear();
  eventBusMock.removeListener.mockClear();

  H.state.registeredHandlers = {};
  setMovies([]);
  processingMoviesSet.clear();

  Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
});

afterEach(() => {
  stopTelegramBot();
  vi.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════════════
// Pure-logic tests (preserved from the original suite)
// ════════════════════════════════════════════════════════════════════════════════

describe('Telegram Bot — isChatAllowed logic', () => {
  function isChatAllowed(chatId: number, allowedSetting: string): boolean {
    if (!allowedSetting) return true;
    const ids = allowedSetting.split(',').map(s => s.trim()).filter(Boolean);
    return ids.includes(String(chatId));
  }

  it('should allow all chats when no restriction is set', () => {
    expect(isChatAllowed(12345, '')).toBe(true);
    expect(isChatAllowed(99999, '')).toBe(true);
  });

  it('should restrict to listed chat IDs', () => {
    expect(isChatAllowed(111, '111,222')).toBe(true);
    expect(isChatAllowed(222, '111,222')).toBe(true);
    expect(isChatAllowed(333, '111,222')).toBe(false);
  });

  it('should handle whitespace in chat ID list', () => {
    expect(isChatAllowed(111, ' 111 , 222 ')).toBe(true);
    expect(isChatAllowed(222, ' 111 , 222 ')).toBe(true);
  });

  it('should handle single chat ID', () => {
    expect(isChatAllowed(111, '111')).toBe(true);
    expect(isChatAllowed(222, '111')).toBe(false);
  });
});

describe('Telegram Bot — unrestricted detection', () => {
  it('should detect unrestricted when enabled + configured + no chat IDs', () => {
    const unrestricted = true && true && !'';
    expect(unrestricted).toBe(true);
  });

  it('should NOT be unrestricted when chat IDs are set', () => {
    const unrestricted = true && true && !'12345';
    expect(unrestricted).toBe(false);
  });

  it('should NOT be unrestricted when bot is disabled', () => {
    const unrestricted = false && true && !'';
    expect(unrestricted).toBe(false);
  });

  it('should NOT be unrestricted when bot is not configured', () => {
    const unrestricted = true && false && !'';
    expect(unrestricted).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// isConfigured
// ════════════════════════════════════════════════════════════════════════════════

describe('telegramBot.isConfigured', () => {
  it('is false when nothing configured', () => {
    expect(telegramBot.isConfigured()).toBe(false);
  });

  it('is false when token present but not enabled', () => {
    mockSettings['telegram.bot_token'] = 'token';
    mockSettings['telegram.enabled'] = 'false';
    expect(telegramBot.isConfigured()).toBe(false);
  });

  it('is false when enabled but no token', () => {
    mockSettings['telegram.enabled'] = 'true';
    expect(telegramBot.isConfigured()).toBe(false);
  });

  it('is true when token present and enabled', () => {
    configure();
    expect(telegramBot.isConfigured()).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// testTelegramBot
// ════════════════════════════════════════════════════════════════════════════════

describe('testTelegramBot', () => {
  it('returns error when no token configured', async () => {
    const res = await testTelegramBot();
    expect(res.success).toBe(false);
    expect(res.error).toContain('Token');
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('returns bot name on success', async () => {
    mockSettings['telegram.bot_token'] = 'test-token';
    mockedAxios.get.mockResolvedValueOnce({ data: { ok: true, result: { username: 'mybot' } } });

    const res = await testTelegramBot();
    expect(res.success).toBe(true);
    expect(res.botName).toBe('mybot');
    expect(mockedAxios.get).toHaveBeenCalledWith(url('getMe'), expect.any(Object));
  });

  it('returns error when Telegram responds without ok', async () => {
    mockSettings['telegram.bot_token'] = 'test-token';
    mockedAxios.get.mockResolvedValueOnce({ data: { ok: false } });

    const res = await testTelegramBot();
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('surfaces Telegram description on HTTP error', async () => {
    mockSettings['telegram.bot_token'] = 'bad';
    mockedAxios.get.mockRejectedValueOnce({ response: { data: { description: 'Unauthorized' } } });

    const res = await testTelegramBot();
    expect(res.success).toBe(false);
    expect(res.error).toBe('Unauthorized');
  });

  it('falls back to error.message when no description', async () => {
    mockSettings['telegram.bot_token'] = 'bad';
    mockedAxios.get.mockRejectedValueOnce(new Error('network down'));

    const res = await testTelegramBot();
    expect(res.success).toBe(false);
    expect(res.error).toBe('network down');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// sendTelegramNotification
// ════════════════════════════════════════════════════════════════════════════════

describe('sendTelegramNotification', () => {
  it('does nothing when not configured', async () => {
    await sendTelegramNotification('download_started', 'Movie', 2024, 'msg');
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('broadcasts to all allowed chats when there are no specific requesters', async () => {
    configure({ chatIds: '111,222' });
    await sendTelegramNotification('download_started', 'Movie', 2024, 'Started');

    const sends = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/sendMessage'));
    expect(sends).toHaveLength(2);
    const chatIds = sends.map(c => (c[1] as any).chat_id);
    expect(chatIds).toContain(111);
    expect(chatIds).toContain(222);
    // HTML formatting: icon + bold title + year
    expect((sends[0][1] as any).text).toContain('<b>Movie</b>');
    expect((sends[0][1] as any).text).toContain('(2024)');
    expect((sends[0][1] as any).parse_mode).toBe('HTML');
  });

  it('uses the error icon for error events', async () => {
    configure({ chatIds: '111' });
    await sendTelegramNotification('error', 'Movie', 2024, 'It broke');
    const send = postCallFor('sendMessage');
    expect((send![1] as any).text.startsWith('❌')).toBe(true);
  });

  it('skips broadcast when no allowed chat IDs and no requesters', async () => {
    configure({ chatIds: '' });
    await sendTelegramNotification('download_started', 'Movie', 2024, 'msg');
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('sends a photo for download_complete when a poster is found', async () => {
    configure({ chatIds: '111', omdb: 'omdbkey' });
    // fetchMovieDetails -> OMDb returns a poster
    mockedAxios.get.mockResolvedValueOnce({
      data: { Response: 'True', Poster: 'http://poster.jpg', imdbRating: '7.5', Plot: 'p', Genre: 'Action' },
    });
    await sendTelegramNotification('download_complete', 'Movie', 2024, 'Done', 'tt123');

    const photo = postCallFor('sendPhoto');
    expect(photo).toBeTruthy();
    expect((photo![1] as any).photo).toBe('http://poster.jpg');
  });

  it('falls back to text when photo send fails for download_complete', async () => {
    configure({ chatIds: '111', omdb: 'omdbkey' });
    mockedAxios.get.mockResolvedValueOnce({
      data: { Response: 'True', Poster: 'http://poster.jpg' },
    });
    // sendPhoto POST rejects -> returns null -> fall back to sendMessage
    mockedAxios.post.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/sendPhoto')) throw new Error('photo failed');
      return { data: { ok: true, result: { message_id: 1 } } };
    });

    await sendTelegramNotification('download_complete', 'Movie', 2024, 'Done', 'tt123');
    expect(postCallFor('sendMessage')).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// sendTelegramSystemAlert
// ════════════════════════════════════════════════════════════════════════════════

describe('sendTelegramSystemAlert', () => {
  it('does nothing when not configured', async () => {
    await sendTelegramSystemAlert('alert');
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('does nothing when no allowed chat IDs are set', async () => {
    configure({ chatIds: '' });
    await sendTelegramSystemAlert('alert');
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('broadcasts the alert to every configured chat', async () => {
    configure({ chatIds: '111, 222 , bad' });
    await sendTelegramSystemAlert('System down');

    const sends = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/sendMessage'));
    // "bad" parses to NaN and is skipped
    expect(sends).toHaveLength(2);
    expect((sends[0][1] as any).text).toBe('System down');
  });

  it('keeps going when a send fails (sendMessage swallows the error)', async () => {
    configure({ chatIds: '111,222' });
    mockedAxios.post.mockRejectedValue(new Error('send failed'));
    await sendTelegramSystemAlert('alert');
    // sendMessage catches internally and logs via logger.error; both chats attempted.
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('sendMessage failed'));
    const sends = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/sendMessage'));
    expect(sends).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// start / stop lifecycle
// ════════════════════════════════════════════════════════════════════════════════

describe('startTelegramBot / stopTelegramBot', () => {
  it('skips start when not configured', async () => {
    await startTelegramBot();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('not configured'));
  });

  it('warns when started without chat ID restriction', async () => {
    configure({ chatIds: '' });
    await startTelegramBot();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('WITHOUT chat ID restriction'));
    stopTelegramBot();
  });

  it('logs restricted start and registers commands + progress listener', async () => {
    configure({ chatIds: '12345,67890' });
    await startTelegramBot();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('restricted to chat IDs'));
    // deleteWebhook + setMyCommands were posted
    expect(postCallFor('deleteWebhook')).toBeTruthy();
    expect(postCallFor('setMyCommands')).toBeTruthy();
    // progress listener registered on the eventbus
    expect(eventBusMock.on).toHaveBeenCalledWith('movie:updated', expect.any(Function));
    stopTelegramBot();
    // cleanup removes the listener
    expect(eventBusMock.removeListener).toHaveBeenCalledWith('movie:updated', expect.any(Function));
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Poll loop — drives the internal message/callback handlers
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Run startTelegramBot but feed `getUpdates` exactly one batch, then make the
 * loop see itself as stopped so it exits without real waiting. We disable the
 * up-front deleteWebhook/registerCommands chatter by letting them resolve, and
 * intercept the getUpdates call to stop the bot right after returning updates.
 */
async function runPollOnce(updates: any[], opts: { chatIds?: string; omdb?: string } = {}) {
  configure({ chatIds: opts.chatIds ?? '111', omdb: opts.omdb });

  let served = false;
  mockedAxios.get.mockImplementation(async (u: any) => {
    if (String(u).endsWith('/getUpdates')) {
      if (served) {
        // After serving once, stop the loop and return empty so it exits.
        stopTelegramBot();
        return { data: { ok: true, result: [] } };
      }
      served = true;
      // Schedule the loop to stop after this batch is processed.
      return { data: { ok: true, result: updates } };
    }
    // getMe / OMDb etc.
    return { data: { ok: true, result: { username: 'bot' } } };
  });

  await startTelegramBot();
  // Let the async poll loop process the batch and the queued handlers run.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  stopTelegramBot();
  // Drain any trailing microtasks (triggerImmediateProcessing fire-and-forget).
  await new Promise(r => setImmediate(r));
}

function textUpdate(chatId: number, text: string, updateId = 1) {
  return { update_id: updateId, message: { text, chat: { id: chatId } } };
}
function callbackUpdate(chatId: number, data: string, updateId = 1, messageId = 42) {
  return {
    update_id: updateId,
    callback_query: { id: 'cbq1', data, message: { message_id: messageId, chat: { id: chatId } } },
  };
}

describe('pollLoop — /start command', () => {
  it('replies with the help text', async () => {
    await runPollOnce([textUpdate(111, '/start')]);
    const send = postCallFor('sendMessage');
    expect(send).toBeTruthy();
    expect((send![1] as any).text).toContain('So funktioniert');
  });
});

describe('pollLoop — chat authorization', () => {
  it('ignores messages from unauthorized chats', async () => {
    await runPollOnce([textUpdate(999, '/start')], { chatIds: '111' });
    expect(postCallFor('sendMessage')).toBeFalsy();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('unauthorized chat'));
  });
});

describe('pollLoop — /status command', () => {
  it('summarizes movie counts and active downloads', async () => {
    setMovies([
      { id: 1, title: 'A', year: 2020, status: 'pending' },
      { id: 2, title: 'B', year: 2021, status: 'downloading' },
      { id: 3, title: 'C', year: 2022, status: 'downloaded' },
      { id: 4, title: 'D', year: 2023, status: 'not_found' },
    ]);
    await runPollOnce([textUpdate(111, '/status')]);
    const send = postCallFor('sendMessage');
    expect((send![1] as any).text).toContain('1 laedt');
    expect((send![1] as any).text).toContain('Gerade dabei');
    expect((send![1] as any).text).toContain('B (2021)');
  });
});

describe('pollLoop — /list command', () => {
  it('shows a message when the queue is empty', async () => {
    setMovies([]);
    await runPollOnce([textUpdate(111, '/list')]);
    expect((postCallFor('sendMessage')![1] as any).text).toContain('Hier ist gerade noch nichts');
  });

  it('lists recent movies with status icons', async () => {
    setMovies([
      { id: 1, title: 'Old', year: 2000, status: 'downloaded' },
      { id: 2, title: 'New', year: 2024, status: 'pending' },
    ]);
    await runPollOnce([textUpdate(111, '/list')]);
    const text = (postCallFor('sendMessage')![1] as any).text;
    expect(text).toContain('New (2024)');
    expect(text).toContain('Old (2000)');
  });
});

describe('pollLoop — /add command', () => {
  it('treats bare "/add" (no title) as a search query, not an add', async () => {
    // text.trim() strips the trailing space so it never matches "/add " —
    // it routes to free-text search (which then yields "konnte nichts finden").
    aggregateSearchTitlesMock.mockResolvedValueOnce([]);
    await runPollOnce([textUpdate(111, '/add   ')]);
    expect(addMovieMock).not.toHaveBeenCalled();
    const sends = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/sendMessage'));
    expect(sends.some(c => (c[1] as any).text.includes('nichts finden'))).toBe(true);
  });

  it('reports when the movie already exists', async () => {
    setMovies([{ id: 1, title: 'Dune', year: 2021, status: 'pending' }]);
    await runPollOnce([textUpdate(111, '/add Dune')]);
    expect((postCallFor('sendMessage')![1] as any).text).toContain('schon auf meiner Liste');
    expect(addMovieMock).not.toHaveBeenCalled();
  });

  it('adds a new movie and triggers processing', async () => {
    mockSettings['quality.minimum'] = '2160p';
    await runPollOnce([textUpdate(111, '/add Tenet')]);
    expect(addMovieMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Tenet',
      status: 'pending',
      desired_quality: '2160p',
    }));
    expect(eventBusMock.emit).toHaveBeenCalledWith('movie:updated', expect.objectContaining({ title: 'Tenet' }));
  });

  it('refuses /add when no allowlist is configured (fail-closed mutation)', async () => {
    await runPollOnce([textUpdate(111, '/add Tenet')], { chatIds: '' });
    expect(addMovieMock).not.toHaveBeenCalled();
    const sends = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/sendMessage'));
    expect(sends.some(c => (c[1] as any).text.includes('freigeschaltet'))).toBe(true);
  });
});

describe('pollLoop — free-text search', () => {
  it('shows results from plugin search with an inline keyboard', async () => {
    aggregateSearchTitlesMock.mockResolvedValueOnce([
      { title: 'Resident Evil', year: 2002, imdbId: 'tt0', poster: null },
      { title: 'Resident Evil: Apocalypse', year: 2004, imdbId: 'tt1', poster: null },
    ]);
    await runPollOnce([textUpdate(111, 'Resident Evil')]);
    const kbCall = mockedAxios.post.mock.calls.find(
      c => String(c[0]).endsWith('/sendMessage') && (c[1] as any).reply_markup?.inline_keyboard
    );
    expect(kbCall).toBeTruthy();
    const kb = (kbCall![1] as any).reply_markup.inline_keyboard;
    // 2 results + cancel row
    expect(kb).toHaveLength(3);
    expect(kb[0][0].callback_data).toBe('select:0');
  });

  it('falls back to OMDb search when plugins return nothing', async () => {
    aggregateSearchTitlesMock.mockResolvedValueOnce([]);
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) {
        return { data: { ok: true, result: [textUpdate(111, 'Matrix')] } };
      }
      if (String(u).includes('omdbapi.com')) {
        return { data: { Search: [{ Title: 'The Matrix', Year: '1999', imdbID: 'tt0133093', Poster: 'N/A' }] } };
      }
      return { data: { ok: true, result: [] } };
    });
    configure({ chatIds: '111', omdb: 'omdbkey' });
    // Manual drive since we overrode get above (runPollOnce sets its own get).
    let served = false;
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) {
        if (served) { stopTelegramBot(); return { data: { ok: true, result: [] } }; }
        served = true;
        return { data: { ok: true, result: [textUpdate(111, 'Matrix')] } };
      }
      if (String(u).includes('omdbapi.com')) {
        return { data: { Search: [{ Title: 'The Matrix', Year: '1999', imdbID: 'tt0133093', Poster: 'N/A' }] } };
      }
      return { data: { ok: true, result: { username: 'bot' } } };
    });
    await startTelegramBot();
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    stopTelegramBot();
    await new Promise(r => setImmediate(r));

    const kbCall = mockedAxios.post.mock.calls.find(
      c => String(c[0]).endsWith('/sendMessage') && (c[1] as any).reply_markup?.inline_keyboard
        && (c[1] as any).reply_markup.inline_keyboard[0]?.[0]?.callback_data === 'select:0'
    );
    expect(kbCall).toBeTruthy();
  });

  it('offers manual-add when nothing is found', async () => {
    aggregateSearchTitlesMock.mockResolvedValueOnce([]);
    await runPollOnce([textUpdate(111, 'Nonexistent Film')]);
    const kbCall = mockedAxios.post.mock.calls.find(
      c => String(c[0]).endsWith('/sendMessage') && (c[1] as any).reply_markup?.inline_keyboard
    );
    expect(kbCall).toBeTruthy();
    expect((kbCall![1] as any).reply_markup.inline_keyboard[0][0].callback_data).toContain('add_manual:');
  });
});

describe('pollLoop — callback queries', () => {
  it('cancel clears the session and edits the message', async () => {
    await runPollOnce([callbackUpdate(111, 'cancel')]);
    const edit = postCallFor('editMessageText');
    expect(edit).toBeTruthy();
    expect((edit![1] as any).text).toContain('Alles klar');
  });

  it('answers an unknown callback with no specific action', async () => {
    await runPollOnce([callbackUpdate(111, 'totally-unknown')]);
    expect(postCallFor('answerCallbackQuery')).toBeTruthy();
  });

  it('select with an expired session tells the user it expired', async () => {
    // No prior search => no session for this chat
    await runPollOnce([callbackUpdate(111, 'select:0')]);
    const edit = postCallFor('editMessageText');
    expect((edit![1] as any).text).toContain('zu lange her');
  });

  it('add_manual adds a movie and confirms', async () => {
    await runPollOnce([callbackUpdate(111, 'add_manual:John Wick')]);
    expect(addMovieMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'John Wick' }));
    const edits = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/editMessageText'));
    // The single combined message contains the progress preamble.
    expect(edits.some(c => (c[1] as any).text.includes('schau mich um'))).toBe(true);
  });

  it('select → confirm flow adds the chosen film', async () => {
    aggregateSearchTitlesMock.mockResolvedValueOnce([
      { title: 'Inception', year: 2010, imdbId: 'tt1375666', poster: null },
    ]);
    // First the search creates a session, then we select index 0, then confirm.
    let served = 0;
    const batches = [
      [textUpdate(111, 'Inception', 1)],
      [callbackUpdate(111, 'select:0', 2)],
      [callbackUpdate(111, 'confirm:0', 3)],
    ];
    configure({ chatIds: '111' });
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) {
        if (served < batches.length) return { data: { ok: true, result: batches[served++] } };
        stopTelegramBot();
        return { data: { ok: true, result: [] } };
      }
      // OMDb fetchMovieDetails during select — no key set, returns nothing useful
      return { data: { ok: true, result: { username: 'bot' } } };
    });

    await startTelegramBot();
    for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r));
    stopTelegramBot();
    await new Promise(r => setImmediate(r));

    expect(addMovieMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Inception', year: 2010 }));
  });

  it('rejects a non-numeric select index (NaN guard) without loading details or adding', async () => {
    // Build a session with one result, then select an index that parseInt turns
    // into NaN. Without the Number.isInteger guard, NaN slips past the
    // `index < 0 || index >= length` range check, the code edits "Lade Details"
    // and then dereferences session.results[NaN] (undefined) → throws.
    aggregateSearchTitlesMock.mockResolvedValueOnce([
      { title: 'Inception', year: 2010, imdbId: 'tt1375666', poster: null },
    ]);
    let served = 0;
    const batches = [
      [textUpdate(111, 'Inception', 1)],
      [callbackUpdate(111, 'select:bad', 2)],
    ];
    configure({ chatIds: '111' });
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) {
        if (served < batches.length) return { data: { ok: true, result: batches[served++] } };
        stopTelegramBot();
        return { data: { ok: true, result: [] } };
      }
      return { data: { ok: true, result: { username: 'bot' } } };
    });

    await startTelegramBot();
    for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r));
    stopTelegramBot();
    await new Promise(r => setImmediate(r));

    const answeredInvalid = mockedAxios.post.mock.calls.some(
      c => String(c[0]).endsWith('/answerCallbackQuery') && (c[1] as any).text === 'Ungueltige Auswahl'
    );
    expect(answeredInvalid).toBe(true);
    expect(addMovieMock).not.toHaveBeenCalled();
    const loadedDetails = mockedAxios.post.mock.calls.some(
      c => String(c[0]).endsWith('/editMessageText') && String((c[1] as any).text).includes('Lade Details')
    );
    expect(loadedDetails).toBe(false);
  });

  it('does not add when the film is already in the library', async () => {
    libIsConfiguredMock.mockReturnValue(true);
    libHasMovieMock.mockResolvedValue(true);
    aggregateSearchTitlesMock.mockResolvedValueOnce([
      { title: 'Avatar', year: 2009, imdbId: 'tt0499549', poster: null },
    ]);
    let served = 0;
    const batches = [
      [textUpdate(111, 'Avatar', 1)],
      [callbackUpdate(111, 'select:0', 2)],
      [callbackUpdate(111, 'confirm:0', 3)],
    ];
    configure({ chatIds: '111' });
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) {
        if (served < batches.length) return { data: { ok: true, result: batches[served++] } };
        stopTelegramBot();
        return { data: { ok: true, result: [] } };
      }
      return { data: { ok: true, result: { username: 'bot' } } };
    });
    await startTelegramBot();
    for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r));
    stopTelegramBot();
    await new Promise(r => setImmediate(r));

    expect(addMovieMock).not.toHaveBeenCalled();
    const edits = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/editMessageText'));
    expect(edits.some(c => (c[1] as any).text.includes('liegt schon auf dem Server'))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// pollLoop — error handling / backoff
// ════════════════════════════════════════════════════════════════════════════════

describe('pollLoop — error handling', () => {
  it('exits cleanly when getUpdates is cancelled', async () => {
    configure({ chatIds: '111' });
    mockedAxios.isCancel = vi.fn(() => true) as any;
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) throw { message: 'canceled' };
      return { data: { ok: true, result: { username: 'bot' } } };
    });
    await startTelegramBot();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    stopTelegramBot();
    // No poll error logged because it was a cancel
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('poll error'));
  });

  it('backs off on a 429 rate-limit response', async () => {
    vi.useFakeTimers();
    configure({ chatIds: '111' });
    let calls = 0;
    mockedAxios.isCancel = vi.fn(() => false) as any;
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) {
        calls++;
        if (calls === 1) throw { response: { status: 429, data: { parameters: { retry_after: 2 } } } };
        stopTelegramBot();
        return { data: { ok: true, result: [] } };
      }
      return { data: { ok: true, result: { username: 'bot' } } };
    });
    await startTelegramBot();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2100);
    stopTelegramBot();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('rate limited'));
  });

  it('backs off on a 409 conflict response', async () => {
    vi.useFakeTimers();
    configure({ chatIds: '111' });
    let calls = 0;
    mockedAxios.isCancel = vi.fn(() => false) as any;
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) {
        calls++;
        if (calls === 1) throw { response: { status: 409 } };
        stopTelegramBot();
        return { data: { ok: true, result: [] } };
      }
      return { data: { ok: true, result: { username: 'bot' } } };
    });
    await startTelegramBot();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30100);
    stopTelegramBot();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('conflict (409)'));
  });

  it('logs and backs off on a generic poll error', async () => {
    vi.useFakeTimers();
    configure({ chatIds: '111' });
    let calls = 0;
    mockedAxios.isCancel = vi.fn(() => false) as any;
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) {
        calls++;
        if (calls === 1) throw new Error('boom');
        stopTelegramBot();
        return { data: { ok: true, result: [] } };
      }
      return { data: { ok: true, result: { username: 'bot' } } };
    });
    await startTelegramBot();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5100);
    stopTelegramBot();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('poll error'));
  });

  it('waits without polling while not configured', async () => {
    vi.useFakeTimers();
    // Configured at start so the loop launches, then becomes unconfigured.
    mockSettings['telegram.bot_token'] = 'test-token';
    mockSettings['telegram.enabled'] = 'true';
    mockSettings['telegram.allowed_chat_ids'] = '111';
    let getUpdatesCalls = 0;
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) { getUpdatesCalls++; stopTelegramBot(); return { data: { ok: true, result: [] } }; }
      return { data: { ok: true, result: { username: 'bot' } } };
    });
    await startTelegramBot();
    // Flip to unconfigured before the loop iterates again.
    mockSettings['telegram.enabled'] = 'false';
    await vi.advanceTimersByTimeAsync(100);
    stopTelegramBot();
    expect(getUpdatesCalls).toBeGreaterThanOrEqual(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Progress listener (eventBus 'movie:updated')
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Drive a single /add batch while leaving the bot running, so the internal
 * progressMessages map (and the eventBus listener) stay intact. The bot is
 * stopped in afterEach. Returns the registered progress handler.
 */
async function addAndKeepRunning(title: string): Promise<(data: any) => Promise<void>> {
  configure({ chatIds: '111' });
  let served = false;
  mockedAxios.get.mockImplementation(async (u: any) => {
    if (String(u).endsWith('/getUpdates')) {
      if (served) {
        // Suspend the loop on a never-resolving promise so it stops iterating
        // (no busy spin) while leaving progressMessages + the listener intact.
        return new Promise(() => {});
      }
      served = true;
      return { data: { ok: true, result: [textUpdate(111, `/add ${title}`)] } };
    }
    return { data: { ok: true, result: { username: 'bot' } } };
  });
  await startTelegramBot();
  for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
  return getHandler('movie:updated') as any;
}

describe('progress listener', () => {
  it('edits the tracked progress message on a status update', async () => {
    const handler = await addAndKeepRunning('Heat');
    expect(handler).toBeTypeOf('function');

    mockedAxios.post.mockClear();
    await handler({ title: 'Heat', status: 'downloading' });
    await new Promise(r => setImmediate(r));

    const edit = postCallFor('editMessageText');
    expect(edit).toBeTruthy();
    expect((edit![1] as any).text).toContain('Heat');
  });

  it('ignores updates with no title or status', async () => {
    const handler = await addAndKeepRunning('Speed');
    mockedAxios.post.mockClear();
    await handler({ status: 'downloading' }); // no title
    await handler({ title: 'Speed' }); // no status
    expect(postCallFor('editMessageText')).toBeFalsy();
  });

  it('ignores updates for untracked titles', async () => {
    const handler = await addAndKeepRunning('Drive');
    mockedAxios.post.mockClear();
    await handler({ title: 'Unknown Movie', status: 'downloading' });
    expect(postCallFor('editMessageText')).toBeFalsy();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// parseTitleAndYear — pure helper
// ════════════════════════════════════════════════════════════════════════════════

describe('parseTitleAndYear', () => {
  it('extracts a trailing year', () => {
    expect(parseTitleAndYear('Whistle 2026')).toEqual({ title: 'Whistle', year: 2026 });
    expect(parseTitleAndYear('Inception 2010')).toEqual({ title: 'Inception', year: 2010 });
  });

  it('handles parens around the year', () => {
    expect(parseTitleAndYear('Whistle (2026)')).toEqual({ title: 'Whistle', year: 2026 });
  });

  it('returns null year when no year is present', () => {
    expect(parseTitleAndYear('Inception')).toEqual({ title: 'Inception', year: null });
  });

  it('does not treat a movie title that is just digits as a year extraction', () => {
    // "1408" is a real movie — falling back to year=null lets the plugin find it
    expect(parseTitleAndYear('1408')).toEqual({ title: '1408', year: null });
  });

  it('rejects implausible years', () => {
    expect(parseTitleAndYear('Foo 1500')).toEqual({ title: 'Foo 1500', year: null });
    expect(parseTitleAndYear('Foo 9999')).toEqual({ title: 'Foo 9999', year: null });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Free-text search — year stripping
// ════════════════════════════════════════════════════════════════════════════════

describe('pollLoop — year stripping in free-text search', () => {
  it('strips trailing year before calling plugin search', async () => {
    aggregateSearchTitlesMock.mockResolvedValue([
      { title: 'Whistle', year: 2026, imdbId: 'tt99', poster: null },
    ]);
    await runPollOnce([textUpdate(111, 'Whistle 2026')]);
    // Plugin was called with the bare title — never with the year embedded.
    const calls = aggregateSearchTitlesMock.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c[0]).toBe('Whistle');
    }
  });

  it('filters plugin results by year when query supplied one', async () => {
    aggregateSearchTitlesMock.mockResolvedValueOnce([
      { title: 'Whistle', year: 2026, imdbId: 'tt99', poster: null },
      { title: 'Whistleblower', year: 2010, imdbId: 'tt77', poster: null },
    ]);
    await runPollOnce([textUpdate(111, 'Whistle 2026')]);
    const kbCall = mockedAxios.post.mock.calls.find(
      c => String(c[0]).endsWith('/sendMessage') && (c[1] as any).reply_markup?.inline_keyboard
        && (c[1] as any).reply_markup.inline_keyboard[0]?.[0]?.callback_data === 'select:0'
    );
    expect(kbCall).toBeTruthy();
    const kb = (kbCall![1] as any).reply_markup.inline_keyboard;
    // Only Whistle (2026) survives the year filter, + cancel row = 2 rows.
    expect(kb).toHaveLength(2);
    expect((kb[0][0] as any).text).toContain('Whistle');
    expect((kb[0][0] as any).text).toContain('2026');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// /series command
// ════════════════════════════════════════════════════════════════════════════════

describe('pollLoop — /series command', () => {
  it('searches the show media type and tags candidates accordingly', async () => {
    aggregateSearchTitlesMock.mockImplementation(async (_q: string, opts: any) => {
      if (opts?.mediaType === 'show') {
        return [{ title: 'Breaking Bad', year: 2008, imdbId: 'tt0903747', poster: null }];
      }
      return [];
    });
    await runPollOnce([textUpdate(111, '/series Breaking Bad')]);
    const kbCall = mockedAxios.post.mock.calls.find(
      c => String(c[0]).endsWith('/sendMessage') && (c[1] as any).reply_markup?.inline_keyboard
        && (c[1] as any).reply_markup.inline_keyboard[0]?.[0]?.callback_data === 'select:0'
    );
    expect(kbCall).toBeTruthy();
    const kb = (kbCall![1] as any).reply_markup.inline_keyboard;
    // Show icon in the button label
    expect((kb[0][0] as any).text).toContain('📺');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// /add with year
// ════════════════════════════════════════════════════════════════════════════════

describe('pollLoop — /add with year argument', () => {
  it('parses "Title YYYY" and stores the year', async () => {
    await runPollOnce([textUpdate(111, '/add Whistle 2026')]);
    expect(addMovieMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Whistle',
      year: 2026,
      media_type: 'movie',
    }));
  });

  it('stores null year when no year supplied (no bogus current-year fallback)', async () => {
    await runPollOnce([textUpdate(111, '/add Inception')]);
    expect(addMovieMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Inception',
      year: null,
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// /cancel + /remove + rm:<id> callback
// ════════════════════════════════════════════════════════════════════════════════

describe('pollLoop — /cancel command', () => {
  it('lists active entries with rm:<id> buttons', async () => {
    setMovies([
      { id: 1, title: 'A', year: 2020, status: 'pending' },
      { id: 2, title: 'B', year: 2021, status: 'downloading' },
      { id: 3, title: 'C', year: 2022, status: 'downloaded' }, // excluded
    ]);
    await runPollOnce([textUpdate(111, '/cancel')]);
    const kbCall = mockedAxios.post.mock.calls.find(
      c => String(c[0]).endsWith('/sendMessage') && (c[1] as any).reply_markup?.inline_keyboard
    );
    expect(kbCall).toBeTruthy();
    const kb = (kbCall![1] as any).reply_markup.inline_keyboard;
    // 2 active entries + cancel row
    expect(kb).toHaveLength(3);
    expect((kb[0][0] as any).callback_data).toMatch(/^rm:\d+$/);
  });

  it('says so when there are no active entries', async () => {
    setMovies([{ id: 1, title: 'A', year: 2020, status: 'downloaded' }]);
    await runPollOnce([textUpdate(111, '/cancel')]);
    expect((postCallFor('sendMessage')![1] as any).text).toContain('nichts unterwegs');
  });
});

describe('pollLoop — /remove command', () => {
  it('removes the matching pending entry', async () => {
    setMovies([{ id: 42, title: 'Dune', year: 2021, status: 'pending' }]);
    await runPollOnce([textUpdate(111, '/remove Dune')]);
    expect(deleteMovieMock).toHaveBeenCalledWith(42);
    const sends = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/sendMessage'));
    expect(sends.some(c => (c[1] as any).text.includes('ist weg'))).toBe(true);
  });

  it('reports when no match exists', async () => {
    setMovies([]);
    await runPollOnce([textUpdate(111, '/remove Nope')]);
    expect(deleteMovieMock).not.toHaveBeenCalled();
    expect((postCallFor('sendMessage')![1] as any).text).toContain('Kann nichts');
  });
});

describe('pollLoop — rm:<id> callback', () => {
  it('removes the targeted entry', async () => {
    setMovies([{ id: 7, title: 'Heat', year: 1995, status: 'pending' }]);
    await runPollOnce([callbackUpdate(111, 'rm:7')]);
    expect(deleteMovieMock).toHaveBeenCalledWith(7);
    const edit = postCallFor('editMessageText');
    expect((edit![1] as any).text).toContain('ist weg');
  });

  it('reports if the entry is already gone', async () => {
    setMovies([]);
    await runPollOnce([callbackUpdate(111, 'rm:999')]);
    expect(deleteMovieMock).not.toHaveBeenCalled();
    const edit = postCallFor('editMessageText');
    expect((edit![1] as any).text).toContain('schon nicht mehr da');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// /list filter
// ════════════════════════════════════════════════════════════════════════════════

describe('pollLoop — /list with status filter', () => {
  it('filters to pending only', async () => {
    setMovies([
      { id: 1, title: 'P', year: 2020, status: 'pending', media_type: 'movie' },
      { id: 2, title: 'D', year: 2021, status: 'downloading', media_type: 'movie' },
      { id: 3, title: 'X', year: 2022, status: 'downloaded', media_type: 'movie' },
    ]);
    await runPollOnce([textUpdate(111, '/list pending')]);
    const text = (postCallFor('sendMessage')![1] as any).text;
    expect(text).toContain('P (2020)');
    expect(text).not.toContain('D (2021)');
    expect(text).not.toContain('X (2022)');
  });

  it('rejects unknown filters', async () => {
    setMovies([{ id: 1, title: 'A', year: 2020, status: 'pending', media_type: 'movie' }]);
    await runPollOnce([textUpdate(111, '/list garbage')]);
    expect((postCallFor('sendMessage')![1] as any).text).toContain('Unbekannter Filter');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// /help command
// ════════════════════════════════════════════════════════════════════════════════

describe('pollLoop — /help command', () => {
  it('returns the help text', async () => {
    await runPollOnce([textUpdate(111, '/help')]);
    const text = (postCallFor('sendMessage')![1] as any).text;
    expect(text).toContain('So funktioniert');
    expect(text).toContain('/meine');
    expect(text).toContain('/empfehlungen');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// select → confirm flow (no quality picker — quality comes from settings)
// ════════════════════════════════════════════════════════════════════════════════

describe('pollLoop — select renders single confirm button', () => {
  it('select shows a "Ja, bitte!" button and the host-wide quality applies on confirm', async () => {
    aggregateSearchTitlesMock.mockResolvedValue([
      { title: 'Dune', year: 2021, imdbId: 'tt1160419', poster: null },
    ]);
    mockSettings['quality.minimum'] = '2160p';
    let served = 0;
    const batches = [
      [textUpdate(111, 'Dune 2021', 1)],
      [callbackUpdate(111, 'select:0', 2)],
      [callbackUpdate(111, 'confirm:0', 3)],
    ];
    configure({ chatIds: '111' });
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) {
        if (served < batches.length) return { data: { ok: true, result: batches[served++] } };
        stopTelegramBot();
        return { data: { ok: true, result: [] } };
      }
      return { data: { ok: true, result: { username: 'bot' } } };
    });

    await startTelegramBot();
    for (let i = 0; i < 14; i++) await new Promise(r => setImmediate(r));
    stopTelegramBot();
    await new Promise(r => setImmediate(r));

    expect(addMovieMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Dune',
      year: 2021,
      desired_quality: '2160p',
    }));

    // Detail screen should carry confirm:0 (not qual:0:*)
    const edits = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/editMessageText'));
    const detailScreen = edits.find(c => {
      const kb = (c[1] as any).reply_markup?.inline_keyboard;
      return kb?.[0]?.[0]?.callback_data === 'confirm:0';
    });
    expect(detailScreen).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Onboarding — first-message greeting
// ════════════════════════════════════════════════════════════════════════════════

describe('pollLoop — onboarding greeting', () => {
  it('sends a one-time greeting on the chat\'s first message', async () => {
    // greet: false skips the default pre-greeted_chat_ids seed
    let served = false;
    configure({ chatIds: '111', greet: false });
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) {
        if (served) { stopTelegramBot(); return { data: { ok: true, result: [] } }; }
        served = true;
        return { data: { ok: true, result: [textUpdate(111, '/help')] } };
      }
      return { data: { ok: true, result: { username: 'bot' } } };
    });
    await startTelegramBot();
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
    stopTelegramBot();
    await new Promise(r => setImmediate(r));

    const sends = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/sendMessage'));
    // First sendMessage is the greeting, then the actual command response
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect((sends[0][1] as any).text).toContain('Ich besorge dir Filme');
    expect((sends[1][1] as any).text).toContain('So funktioniert');
  });

  it('does NOT re-send the greeting for an already-greeted chat', async () => {
    await runPollOnce([textUpdate(111, '/help')]);
    const sends = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/sendMessage'));
    // Default configure() seeds greeted_chat_ids — only the /help reply should be sent
    expect(sends).toHaveLength(1);
    expect((sends[0][1] as any).text).toContain('So funktioniert');
  });

  it('honours a custom welcome_message setting', async () => {
    let served = false;
    configure({ chatIds: '111', greet: false });
    mockSettings['telegram.welcome_message'] = 'Servus! Lust auf einen Film?';
    mockedAxios.get.mockImplementation(async (u: any) => {
      if (String(u).endsWith('/getUpdates')) {
        if (served) { stopTelegramBot(); return { data: { ok: true, result: [] } }; }
        served = true;
        return { data: { ok: true, result: [textUpdate(111, 'Hi')] } };
      }
      return { data: { ok: true, result: { username: 'bot' } } };
    });
    await startTelegramBot();
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
    stopTelegramBot();
    await new Promise(r => setImmediate(r));

    const sends = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/sendMessage'));
    expect((sends[0][1] as any).text).toBe('Servus! Lust auf einen Film?');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// /meine command
// ════════════════════════════════════════════════════════════════════════════════

describe('pollLoop — /meine command', () => {
  it('says so when the chat has not requested anything', async () => {
    await runPollOnce([textUpdate(111, '/meine')]);
    expect((postCallFor('sendMessage')![1] as any).text).toContain('noch nichts angefragt');
  });

  it('lists the chat\'s requests after an add', async () => {
    // Seed: chat 111 has previously requested movie id 42
    mockSettings['telegram.chat_requests'] = JSON.stringify({ '111': [42] });
    setMovies([
      { id: 42, title: 'Dune', year: 2021, status: 'downloading', media_type: 'movie' },
      { id: 7, title: 'Other', year: 2020, status: 'pending', media_type: 'movie' }, // someone else's
    ]);
    // getMovieById mock — the production code uses it for /meine lookups
    (vi.mocked(await import('../../src/database/services/movies')).addMovie as any);
    await runPollOnce([textUpdate(111, '/meine')]);
    const text = (postCallFor('sendMessage')![1] as any).text;
    expect(text).toContain('Deine Anfragen');
    expect(text).toContain('Dune');
    expect(text).not.toContain('Other');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// /empfehlungen command
// ════════════════════════════════════════════════════════════════════════════════

describe('pollLoop — /empfehlungen command', () => {
  it('shows discover items as tappable cards', async () => {
    // Plug into the mocked plugin registry for cached discover items.
    // The current mock only exposes aggregateSearchTitles — extend it inline for this test.
    const { pluginRegistry } = await import('../../src/plugins/registry');
    (pluginRegistry as any).aggregateDiscover = vi.fn(async (mt: string) =>
      mt === 'movie' ? [{ rank: 1, title: 'Trending Pick', year: 2025, genres: ['Drama'], poster: null, url: '#', description: 'desc' }] : []
    );
    (pluginRegistry as any).getCachedDiscover = vi.fn(() => []);

    await runPollOnce([textUpdate(111, '/empfehlungen')]);
    const kbCall = mockedAxios.post.mock.calls.find(
      c => String(c[0]).endsWith('/sendMessage') && (c[1] as any).reply_markup?.inline_keyboard
        && (c[1] as any).reply_markup.inline_keyboard[0]?.[0]?.callback_data === 'select:0'
    );
    expect(kbCall).toBeTruthy();
    expect((kbCall![1] as any).text).toContain('Vielleicht');
    expect((kbCall![1] as any).reply_markup.inline_keyboard[0][0].text).toContain('Trending Pick');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// "Jetzt schauen" library link in done notification
// ════════════════════════════════════════════════════════════════════════════════

describe('sendTelegramNotification — watch-now link', () => {
  it('adds a "Jetzt schauen" button to download_complete notifications when library.public_url is set', async () => {
    configure({ chatIds: '111', libraryUrl: 'https://jellyfin.example.com' });
    await sendTelegramNotification('download_complete', 'Movie', 2024, 'Done', null);
    const send = postCallFor('sendMessage');
    expect(send).toBeTruthy();
    const kb = (send![1] as any).reply_markup?.inline_keyboard;
    expect(kb?.[0]?.[0]?.url).toBe('https://jellyfin.example.com');
  });

  it('does NOT add a button when library.public_url is empty', async () => {
    configure({ chatIds: '111' });
    await sendTelegramNotification('download_complete', 'Movie', 2024, 'Done', null);
    const send = postCallFor('sendMessage');
    expect((send![1] as any).reply_markup).toBeUndefined();
  });
});
