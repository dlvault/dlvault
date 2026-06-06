import { describe, it, expect, vi } from 'vitest';

const store = vi.hoisted(() => ({ v: {} as Record<string, string> }));
vi.mock('../../src/database/index', () => ({
  getSetting: (k: string) => store.v[k] ?? '',
  setSetting: (k: string, v: string) => { store.v[k] = v; },
}));

import { upgradingMovies, persistUpgradingMovies, restoreUpgradingMovies } from '../../src/services/processingState';

describe('upgrade markers survive a restart', () => {
  it('restores what was persisted', () => {
    // Lost on restart, an in-flight upgrade was closed against the OLD file and
    // the arriving HEVC file was discarded as "smaller, so worse".
    upgradingMovies.add(7); upgradingMovies.add(42);
    persistUpgradingMovies();

    upgradingMovies.clear();            // the process restarts
    expect(restoreUpgradingMovies()).toBe(2);
    expect([...upgradingMovies].sort((a, b) => a - b)).toEqual([7, 42]);
  });

  it('ignores garbage in the stored value', () => {
    upgradingMovies.clear();
    store.v['state.upgrading_movies'] = '5,,x,-3,9';
    restoreUpgradingMovies();
    expect([...upgradingMovies].sort((a, b) => a - b)).toEqual([5, 9]);
  });
});
