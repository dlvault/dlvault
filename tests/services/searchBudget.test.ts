import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSettings, dbMock } = vi.hoisted(() => ({
  mockSettings: {} as Record<string, string>,
  dbMock: { recent: 0, downloads: 1 },
}));
vi.mock('../../src/database/index', () => ({
  getSetting: (k: string) => mockSettings[k] ?? '',
  default: {
    prepare: (sql: string) => ({
      get: () => (sql.includes('FROM downloads') ? { c: dbMock.downloads } : { c: dbMock.recent }),
    }),
  },
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { budgetHold, budgetedRun, leftoverFor, _resetSearchBudget, type BudgetSettings } from '../../src/services/searchBudget';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const cfg = (over: Partial<BudgetSettings> = {}): BudgetSettings => ({ maxPerHour: 0, minDays: 0, loopGuard: false, ...over });
function movie(over: Record<string, any> = {}): any {
  return {
    id: 5, title: 'Film', media_type: 'movie', status: 'not_found', retry_count: 3, repair: 0,
    added_at: '2026-01-01 00:00:00', last_checked_at: '2026-10-14 12:00:00', ...over,
  };
}

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  dbMock.recent = 0;
  _resetSearchBudget();
});

describe('leftoverFor', () => {
  it('matches a loose file and a release folder of the title', () => {
    expect(leftoverFor('Sex', ['Sex - S01 1080p.mkv'])).toBe('Sex - S01 1080p.mkv');
    expect(leftoverFor('Barry', ['Barry.S03.German.DL'])).toBe('Barry.S03.German.DL');
    expect(leftoverFor('Carrie', ['Carrie (2026) - S01'])).toBe('Carrie (2026) - S01');
  });
  it('does not match another title that merely starts with the same word', () => {
    expect(leftoverFor('Sex', ['Sex Weather (2023)', 'Sexy.S01'])).toBeNull();
  });
  it('ignores the unfinished folder and empty titles', () => {
    expect(leftoverFor('Sex', ['unfertige'])).toBeNull();
    expect(leftoverFor('', ['x'])).toBeNull();
  });
});

describe('budgetHold', () => {
  it('holds nothing with the defaults', () => {
    expect(budgetHold(movie(), NOW, cfg(), 99, 'x')).toBeNull();
  });
  it('never holds a title that was never searched', () => {
    expect(budgetHold(movie({ last_checked_at: null, retry_count: 0 }), NOW, cfg({ minDays: 7, maxPerHour: 1, loopGuard: true }), 5, 'x')).toBeNull();
  });
  it('minimum distance holds until last check + days + offset', () => {
    expect(budgetHold(movie(), NOW, cfg({ minDays: 7 }), 0, null)?.reason).toMatch(/Mindestabstand 7 Tage/);
    expect(budgetHold(movie({ last_checked_at: '2026-10-01 00:00:00' }), NOW, cfg({ minDays: 7 }), 0, null)).toBeNull();
  });
  it('a show that is still downloading is not paced by the distance', () => {
    expect(budgetHold(movie({ media_type: 'show', status: 'downloading' }), NOW, cfg({ minDays: 7 }), 0, null)).toBeNull();
  });
  it('a title added within two days is exempt from distance and hourly limit', () => {
    const young = movie({ added_at: '2026-10-14 12:00:00' });
    expect(budgetHold(young, NOW, cfg({ minDays: 7, maxPerHour: 1 }), 5, null)).toBeNull();
  });
  it('hourly limit counts recent searches', () => {
    expect(budgetHold(movie(), NOW, cfg({ maxPerHour: 3 }), 3, null)?.reason).toMatch(/Stundenlimit 3/);
    expect(budgetHold(movie(), NOW, cfg({ maxPerHour: 3 }), 2, null)).toBeNull();
  });
  it('loop guard holds on leftovers, even for a young title', () => {
    expect(budgetHold(movie({ added_at: '2026-10-14 12:00:00' }), NOW, cfg({ loopGuard: true }), 0, 'Sex - S01 1080p.mkv')?.reason).toMatch(/Download-Ordner/);
    expect(budgetHold(movie(), NOW, cfg({ loopGuard: false }), 0, 'Sex - S01 1080p.mkv')).toBeNull();
  });
});

describe('budgetedRun', () => {
  it('runs the search when no knob is set', async () => {
    const search = vi.fn(async () => undefined);
    expect(await budgetedRun(movie(), search)).toBe(false);
    expect(search).toHaveBeenCalledOnce();
  });
  it('does not run when the hourly limit is reached', async () => {
    mockSettings['scheduler.max_searches_per_hour'] = '2';
    dbMock.recent = 2;
    const search = vi.fn(async () => undefined);
    expect(await budgetedRun(movie(), search)).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });
  it('counts running searches against the hourly limit', async () => {
    mockSettings['scheduler.max_searches_per_hour'] = '1';
    let release!: () => void;
    const first = budgetedRun(movie({ id: 1 }), () => new Promise<void>(r => { release = r; }));
    const search = vi.fn(async () => undefined);
    expect(await budgetedRun(movie({ id: 2 }), search)).toBe(true);
    release();
    await first;
    expect(search).not.toHaveBeenCalled();
  });
});
