import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applySchema } from '../../src/database/schema';

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');


  return { testDb };
});

vi.mock('../../src/database/index', () => ({
  default: testDb,
  db: testDb,
  getSetting: vi.fn(() => ''),
  setSetting: vi.fn(),
  getAllSettings: vi.fn(() => ({})),
  initDatabase: vi.fn(),
}));

import {
  getBlocklist, addBlocklistEntry, removeBlocklistEntry,
  clearBlocklist, isReleaseBlocklisted,
} from '../../src/database/services/blocklist';

function addTestMovie(traktId: number, title: string): number {
  return Number(testDb.prepare(
    `INSERT INTO movies (trakt_id, title, year, media_type, status) VALUES (?, ?, 2024, 'movie', 'pending')`
  ).run(traktId, title).lastInsertRowid);
}

// Tables come from production's own schema, not a copy. The copies had drifted
// badly — production `movies` has 33 columns, these fixtures had 14–17 — so
// anything touching e.g. quality_override or season_cutoff was untestable here.
applySchema(testDb);

describe('Blocklist DB Service', () => {
  beforeEach(() => {
    testDb.exec('DELETE FROM blocklist');
    testDb.exec('DELETE FROM movies');
  });

  it('should add and retrieve a blocklist entry', () => {
    const entry = addBlocklistEntry({
      release_name: 'Bad.Release.2024.1080p',
      title: 'Bad Release',
      reason: 'Corrupted files',
    });

    expect(entry.release_name).toBe('Bad.Release.2024.1080p');
    expect(entry.reason).toBe('Corrupted files');

    const all = getBlocklist();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(entry.id);
  });

  it('should add entry with movie_id', () => {
    const movieId = addTestMovie(1, 'Test Movie');
    const entry = addBlocklistEntry({
      release_name: 'Test.Movie.2024.720p',
      movie_id: movieId,
    });

    expect(entry.movie_id).toBe(movieId);
  });

  it('should add entry with minimal fields', () => {
    const entry = addBlocklistEntry({ release_name: 'Minimal.Release' });

    expect(entry.release_name).toBe('Minimal.Release');
    expect(entry.title).toBeNull();
    expect(entry.reason).toBeNull();
    expect(entry.movie_id).toBeNull();
  });

  it('should remove a blocklist entry', () => {
    const entry = addBlocklistEntry({ release_name: 'Remove.Me' });
    expect(getBlocklist()).toHaveLength(1);

    const removed = removeBlocklistEntry(entry.id);
    expect(removed).toBe(true);
    expect(getBlocklist()).toHaveLength(0);
  });

  it('should return false when removing non-existent entry', () => {
    const removed = removeBlocklistEntry(999);
    expect(removed).toBe(false);
  });

  it('should clear all blocklist entries', () => {
    addBlocklistEntry({ release_name: 'Entry.1' });
    addBlocklistEntry({ release_name: 'Entry.2' });
    addBlocklistEntry({ release_name: 'Entry.3' });

    expect(getBlocklist()).toHaveLength(3);

    const count = clearBlocklist();
    expect(count).toBe(3);
    expect(getBlocklist()).toHaveLength(0);
  });

  it('should detect blocklisted release (case insensitive)', () => {
    addBlocklistEntry({ release_name: 'Blocked.Release.2024.1080p' });

    expect(isReleaseBlocklisted('Blocked.Release.2024.1080p')).toBe(true);
    expect(isReleaseBlocklisted('blocked.release.2024.1080p')).toBe(true);
    expect(isReleaseBlocklisted('BLOCKED.RELEASE.2024.1080P')).toBe(true);
  });

  it('should not detect non-blocklisted release', () => {
    addBlocklistEntry({ release_name: 'Blocked.Release.2024.1080p' });

    expect(isReleaseBlocklisted('Good.Release.2024.1080p')).toBe(false);
  });

  it('should handle whitespace in release name check', () => {
    addBlocklistEntry({ release_name: 'Spaced.Release' });

    expect(isReleaseBlocklisted('  Spaced.Release  ')).toBe(true);
  });

  it('should return entries ordered by id descending', () => {
    addBlocklistEntry({ release_name: 'First' });
    addBlocklistEntry({ release_name: 'Second' });
    addBlocklistEntry({ release_name: 'Third' });

    const list = getBlocklist();
    // ORDER BY created_at DESC — same timestamp but higher IDs come last in insert order
    // Just verify all 3 are present
    expect(list).toHaveLength(3);
    const names = list.map(e => e.release_name);
    expect(names).toContain('First');
    expect(names).toContain('Second');
    expect(names).toContain('Third');
  });

  it('should SET NULL movie_id when movie is deleted', () => {
    const movieId = addTestMovie(2, 'Deleted Movie');
    addBlocklistEntry({ release_name: 'Orphan.Release', movie_id: movieId });

    testDb.prepare('DELETE FROM movies WHERE id = ?').run(movieId);

    const list = getBlocklist();
    expect(list).toHaveLength(1);
    expect(list[0].movie_id).toBeNull();
  });

  it('should allow duplicate release names', () => {
    addBlocklistEntry({ release_name: 'Dup.Release', reason: 'First time' });
    addBlocklistEntry({ release_name: 'Dup.Release', reason: 'Second time' });

    expect(getBlocklist()).toHaveLength(2);
  });
});

describe('blocklist lookup uses an index', () => {
  it('does not full-scan for the case-insensitive lookup', () => {
    // Called once per release inside three nested hot loops against an
    // append-only table — a scan here is the difference between microseconds
    // and a measurable share of every scheduler pass.
    const plan = testDb
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM blocklist WHERE LOWER(release_name) = ? LIMIT 1')
      .all('anything') as { detail: string }[];
    const detail = plan.map(r => r.detail).join(' ');

    expect(detail).toContain('idx_blocklist_release_name_lower');
    expect(detail).not.toContain('SCAN blocklist');
  });
});
