import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applySchema } from '../../src/database/schema';

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  return { testDb: new Database(':memory:') };
});
vi.mock('../../src/database/index', () => ({ default: testDb, db: testDb, getSetting: vi.fn(() => '') }));
applySchema(testDb);

import { loadCheckedFiles, markFileChecked, pruneCheckedFiles } from '../../src/database/services/fileChecks';

describe('fileChecks', () => {
  beforeEach(() => { testDb.exec('DELETE FROM file_checks'); });

  it('remembers the size a file was judged at, updating on re-check', () => {
    markFileChecked('/movies/Grell (2024)/Grell (2024).mkv', 100);
    markFileChecked('/movies/Grell (2024)/Grell (2024).mkv', 200);
    expect([...loadCheckedFiles()]).toEqual([['/movies/Grell (2024)/Grell (2024).mkv', 200]]);
  });

  it('forgets vanished files, but not when most are gone (unmounted share)', () => {
    for (const n of ['a', 'b', 'c']) markFileChecked(`/movies/${n}.mkv`, 1);
    expect(pruneCheckedFiles(p => p !== '/movies/a.mkv')).toBe(1);
    expect(loadCheckedFiles().size).toBe(2);
    expect(pruneCheckedFiles(() => false)).toBe(0);
    expect(loadCheckedFiles().size).toBe(2);
  });
});
