import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module
const mockGetSetting = vi.fn((key: string) => '');

vi.mock('../../src/database/index', () => ({
  getSetting: (...args: any[]) => mockGetSetting(...args),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
}));

vi.mock('../../src/database/services/movies', () => ({
  addMovie: vi.fn(() => ({ id: 1, title: 'Test', year: 2024, status: 'pending' })),
  getMovieByTmdbId: vi.fn(),
  getMovieByImdbId: vi.fn(),
  getAllMovies: vi.fn(() => []),
}));

vi.mock('../../src/database/services/activityLog', () => ({
  addLogEntry: vi.fn(),
}));

vi.mock('../../src/services/eventbus', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('axios', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: { ok: true, result: [] } })),
    post: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    isCancel: vi.fn(() => false),
    CancelToken: { source: vi.fn(() => ({ token: {}, cancel: vi.fn() })) },
  },
}));

describe('Telegram Bot — isChatAllowed logic', () => {
  // Replicate the isChatAllowed logic for unit testing
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
    const enabled = true;
    const configured = true;
    const allowedChatIds = '';
    const unrestricted = enabled && configured && !allowedChatIds;
    expect(unrestricted).toBe(true);
  });

  it('should NOT be unrestricted when chat IDs are set', () => {
    const enabled = true;
    const configured = true;
    const allowedChatIds = '12345';
    const unrestricted = enabled && configured && !allowedChatIds;
    expect(unrestricted).toBe(false);
  });

  it('should NOT be unrestricted when bot is disabled', () => {
    const enabled = false;
    const configured = true;
    const allowedChatIds = '';
    const unrestricted = enabled && configured && !allowedChatIds;
    expect(unrestricted).toBe(false);
  });

  it('should NOT be unrestricted when bot is not configured', () => {
    const enabled = true;
    const configured = false;
    const allowedChatIds = '';
    const unrestricted = enabled && configured && !allowedChatIds;
    expect(unrestricted).toBe(false);
  });
});

describe('Telegram Bot — startTelegramBot warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should warn when starting without chat ID restriction', async () => {
    const { logger } = await import('../../src/utils/logger');

    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'telegram.bot_token') return 'test-token';
      if (key === 'telegram.enabled') return 'true';
      if (key === 'telegram.allowed_chat_ids') return '';
      return '';
    });

    const { startTelegramBot, stopTelegramBot } = await import('../../src/services/telegram');

    await startTelegramBot();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('WITHOUT chat ID restriction')
    );

    stopTelegramBot();
  });

  it('should log restricted start when chat IDs are set', async () => {
    const { logger } = await import('../../src/utils/logger');

    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'telegram.bot_token') return 'test-token';
      if (key === 'telegram.enabled') return 'true';
      if (key === 'telegram.allowed_chat_ids') return '12345,67890';
      return '';
    });

    const { startTelegramBot, stopTelegramBot } = await import('../../src/services/telegram');

    await startTelegramBot();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('restricted to chat IDs')
    );

    stopTelegramBot();
  });
});
