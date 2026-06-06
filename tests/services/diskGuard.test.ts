import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/index', () => ({ getSetting: () => '' }));

import { judgeRoom, checkRoom } from '../../src/services/diskGuard';

const GB = 1024 ** 3;
const disk = (id: string, freeGB: number) => ({ id, free: freeGB * GB });

describe('disk guard', () => {
  it('lets a download through when both targets have size plus reserve', () => {
    expect(judgeRoom([
      { label: 'Downloads', info: disk('a', 100) },
      { label: 'Mediathek', info: disk('b', 100) },
    ], 20 * GB, 20 * GB).ok).toBe(true);
  });

  it('stops it when one target is too full, naming which', () => {
    const v = judgeRoom([
      { label: 'Downloads', info: disk('a', 100) },
      { label: 'Mediathek', info: disk('b', 30) },
    ], 20 * GB, 20 * GB);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.detail).toContain('Mediathek: 30.0 GB frei, 40.0 GB nötig');
  });

  it('counts the size twice when both are the same filesystem (copy holds it twice)', () => {
    const same = disk('shfs', 50);
    expect(judgeRoom([
      { label: 'Downloads', info: same },
      { label: 'Mediathek', info: same },
    ], 20 * GB, 20 * GB).ok).toBe(false);   // needs 60 GB on one disk with 50 free
  });

  it('does not judge what it cannot read', () => {
    expect(judgeRoom([{ label: 'Downloads', info: null }], 999 * GB, 20 * GB).ok).toBe(true);
    expect(checkRoom(10, { Downloads: '/definitely/not/here' }).ok).toBe(true);
  });
});
