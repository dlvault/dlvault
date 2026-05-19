import { describe, it, expect, vi } from 'vitest';

// telegram.ts pulls in the DB layer and other services at import time; mock the
// heavy/side-effecting modules so importing escapeHtml has no side effects.
vi.mock('axios');
vi.mock('../../src/database/index', () => ({ getSetting: vi.fn(() => '') }));
vi.mock('../../src/database/services/movies', () => ({
  addMovie: vi.fn(), getMovieByTmdbId: vi.fn(), getMovieByImdbId: vi.fn(),
  getAllMovies: vi.fn(() => []), getMoviesByStatus: vi.fn(() => []),
}));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: vi.fn() }));
vi.mock('../../src/services/eventbus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn() } }));
vi.mock('../../src/plugins/registry', () => ({ pluginRegistry: { forMediaType: vi.fn(() => []) } }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { escapeHtml } from '../../src/services/telegram';

describe('telegram escapeHtml — HTML injection guard for parse_mode:HTML messages', () => {
  it('escapes the three Telegram-significant characters', () => {
    expect(escapeHtml('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;');
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('escapes & before the entities it introduces (no double-encoding bug)', () => {
    // Order matters: & must be replaced first, otherwise the &lt; we emit for
    // `<` would itself get its `&` re-escaped. Verify a single round-trip.
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('keeps a real-world title with an ampersand renderable', () => {
    // "Fast & Furious" would otherwise break Telegram's HTML parser.
    expect(escapeHtml('Fast & Furious')).toBe('Fast &amp; Furious');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('The Matrix')).toBe('The Matrix');
    expect(escapeHtml('')).toBe('');
  });

  it('neutralises an injected anchor/script payload', () => {
    expect(escapeHtml('<a href="x">click</a>'))
      .toBe('&lt;a href="x"&gt;click&lt;/a&gt;');
  });
});
