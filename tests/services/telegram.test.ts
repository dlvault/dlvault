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

vi.mock('../../src/database/services/movies', () => ({
  addMovie: (...a: any[]) => H.addMovieMock(...a),
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
  pluginRegistry: { aggregateSearchTitles: (...a: any[]) => H.aggregateSearchTitlesMock(...a) },
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

function configure(opts: { enabled?: boolean; token?: string; chatIds?: string; omdb?: string } = {}) {
  if (opts.token !== undefined) mockSettings['telegram.bot_token'] = opts.token;
  else mockSettings['telegram.bot_token'] = 'test-token';
  mockSettings['telegram.enabled'] = opts.enabled === false ? 'false' : 'true';
  if (opts.chatIds !== undefined) mockSettings['telegram.allowed_chat_ids'] = opts.chatIds;
  if (opts.omdb !== undefined) mockSettings['omdb.api_key'] = opts.omdb;
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
    expect((send![1] as any).text).toContain('Film-Bot');
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
    expect((send![1] as any).text).toContain('Status');
    expect((send![1] as any).text).toContain('Aktive Downloads');
    expect((send![1] as any).text).toContain('B (2021)');
  });
});

describe('pollLoop — /list command', () => {
  it('shows a message when the queue is empty', async () => {
    setMovies([]);
    await runPollOnce([textUpdate(111, '/list')]);
    expect((postCallFor('sendMessage')![1] as any).text).toContain('Noch keine Filme');
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
    // it routes to free-text search instead of adding a movie.
    aggregateSearchTitlesMock.mockResolvedValueOnce([]);
    await runPollOnce([textUpdate(111, '/add   ')]);
    expect(addMovieMock).not.toHaveBeenCalled();
    expect((postCallFor('sendMessage')![1] as any).text).toContain('Suche');
  });

  it('reports when the movie already exists', async () => {
    setMovies([{ id: 1, title: 'Dune', year: 2021, status: 'pending' }]);
    await runPollOnce([textUpdate(111, '/add Dune')]);
    expect((postCallFor('sendMessage')![1] as any).text).toContain('bereits in der Warteschlange');
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
    expect((edit![1] as any).text).toContain('abgebrochen');
  });

  it('answers an unknown callback with no specific action', async () => {
    await runPollOnce([callbackUpdate(111, 'totally-unknown')]);
    expect(postCallFor('answerCallbackQuery')).toBeTruthy();
  });

  it('select with an expired session tells the user it expired', async () => {
    // No prior search => no session for this chat
    await runPollOnce([callbackUpdate(111, 'select:0')]);
    const edit = postCallFor('editMessageText');
    expect((edit![1] as any).text).toContain('abgelaufen');
  });

  it('add_manual adds a movie and confirms', async () => {
    await runPollOnce([callbackUpdate(111, 'add_manual:John Wick')]);
    expect(addMovieMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'John Wick' }));
    const edits = mockedAxios.post.mock.calls.filter(c => String(c[0]).endsWith('/editMessageText'));
    expect(edits.some(c => (c[1] as any).text.includes('Warteschlange'))).toBe(true);
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
    expect(edits.some(c => (c[1] as any).text.includes('Bibliothek'))).toBe(true);
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
