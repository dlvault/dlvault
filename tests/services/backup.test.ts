import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — backup.ts uses fs, node-cron, getSetting and logger. We mock all of
// them so no real filesystem/timer/DB work happens. Tests exercise the actual
// exported functions in src/services/backup.ts.
// ---------------------------------------------------------------------------

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] ?? null),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// node-cron — schedule returns a task with a stop() spy we can assert on.
const mockStop = vi.fn();
const mockSchedule = vi.fn(() => ({ stop: mockStop }));
vi.mock('node-cron', () => ({
  default: { schedule: (...args: any[]) => mockSchedule(...args) },
}));

// fs — every method is a spy. Default behaviour set in beforeEach.
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    statSync: vi.fn(),
    readdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

import fs from 'fs';
import {
  createBackup,
  listBackups,
  deleteBackup,
  startBackupScheduler,
  stopBackupScheduler,
} from '../../src/services/backup';
import { logger } from '../../src/utils/logger';

const mockFs = vi.mocked(fs, true);

beforeEach(() => {
  // mockReset clears implementations AND the *Once queue (clearAllMocks would
  // not empty the queue), giving each test a clean slate.
  vi.mocked(fs.existsSync).mockReset();
  vi.mocked(fs.mkdirSync).mockReset();
  vi.mocked(fs.copyFileSync).mockReset();
  vi.mocked(fs.statSync).mockReset();
  vi.mocked(fs.readdirSync).mockReset();
  vi.mocked(fs.unlinkSync).mockReset();
  mockSchedule.mockClear();
  mockStop.mockClear();
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.debug).mockClear();
  Object.keys(mockSettings).forEach(k => delete mockSettings[k]);

  // Sensible defaults: nothing exists, stat returns a fixed size, dir is empty.
  mockFs.existsSync.mockReturnValue(false);
  mockFs.statSync.mockReturnValue({ size: 2048, mtime: new Date('2026-01-01T00:00:00Z') } as any);
  mockFs.readdirSync.mockReturnValue([] as any);

  // Ensure no scheduler leaks across tests.
  stopBackupScheduler();
  mockSchedule.mockClear();
  mockStop.mockClear();
});

describe('createBackup', () => {
  it('creates the backup dir when missing and copies the db file', () => {
    mockFs.existsSync.mockReturnValue(false); // backup dir + wal/shm absent
    const result = createBackup();

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('backups'), { recursive: true });
    expect(mockFs.copyFileSync).toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.filename).toMatch(/^dlvault-.*\.db$/);
    expect(result!.size).toBe(2048);
  });

  it('does not recreate the backup dir when it already exists', () => {
    // existsSync: backup dir exists, wal/shm absent
    mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('backups'));
    createBackup();
    expect(mockFs.mkdirSync).not.toHaveBeenCalled();
  });

  it('copies WAL and SHM companion files when they exist', () => {
    // backup dir exists, plus -wal and -shm sidecars
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      return s.endsWith('backups') || s.endsWith('-wal') || s.endsWith('-shm');
    });
    createBackup();

    const copyTargets = mockFs.copyFileSync.mock.calls.map(c => String(c[1]));
    expect(copyTargets.some(t => t.endsWith('.db'))).toBe(true);
    expect(copyTargets.some(t => t.endsWith('-wal'))).toBe(true);
    expect(copyTargets.some(t => t.endsWith('-shm'))).toBe(true);
  });

  it('skips WAL/SHM copies when sidecars are absent', () => {
    mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('backups'));
    createBackup();
    const copyTargets = mockFs.copyFileSync.mock.calls.map(c => String(c[1]));
    expect(copyTargets.some(t => t.endsWith('-wal'))).toBe(false);
    expect(copyTargets.some(t => t.endsWith('-shm'))).toBe(false);
  });

  it('returns null and logs when copying fails', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.copyFileSync.mockImplementation(() => { throw new Error('disk full'); });

    const result = createBackup();
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  it('prunes old backups after creating, keeping max_backups newest', () => {
    mockSettings['backup.max_backups'] = '2';
    // backup dir exists, no wal/shm sidecars
    mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('backups'));
    // 4 existing backups — sorted+reversed keeps the 2 newest, deletes 2 oldest
    mockFs.readdirSync.mockReturnValue([
      'dlvault-2026-01-01.db',
      'dlvault-2026-02-01.db',
      'dlvault-2026-03-01.db',
      'dlvault-2026-04-01.db',
    ] as any);

    createBackup();

    const unlinked = mockFs.unlinkSync.mock.calls.map(c => String(c[0]));
    expect(unlinked.some(u => u.includes('dlvault-2026-01-01.db'))).toBe(true);
    expect(unlinked.some(u => u.includes('dlvault-2026-02-01.db'))).toBe(true);
    expect(unlinked.some(u => u.includes('dlvault-2026-03-01.db'))).toBe(false);
  });

  it('prune defaults to keeping 5 backups when setting is unset', () => {
    mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('backups'));
    mockFs.readdirSync.mockReturnValue(
      Array.from({ length: 7 }, (_, i) => `dlvault-2026-0${i + 1}.db`) as any,
    );
    createBackup();
    // 7 files, keep 5 → 2 deletions
    expect(mockFs.unlinkSync).toHaveBeenCalledTimes(2);
  });

  it('also unlinks WAL/SHM companions of pruned backups', () => {
    mockSettings['backup.max_backups'] = '1';
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      // backup dir + every pruned file's -wal/-shm exist
      return s.endsWith('backups') || s.endsWith('-wal') || s.endsWith('-shm');
    });
    mockFs.readdirSync.mockReturnValue([
      'dlvault-2026-01-01.db',
      'dlvault-2026-02-01.db',
    ] as any);

    createBackup();
    const unlinked = mockFs.unlinkSync.mock.calls.map(c => String(c[0]));
    // The 1 pruned file plus its -wal and -shm sidecars
    expect(unlinked.some(u => u.endsWith('-wal'))).toBe(true);
    expect(unlinked.some(u => u.endsWith('-shm'))).toBe(true);
  });

  it('does not throw if pruning itself fails (readdir error)', () => {
    mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('backups'));
    mockFs.readdirSync.mockImplementation(() => { throw new Error('readdir boom'); });

    const result = createBackup();
    // Backup itself still succeeds; pruning failure is swallowed + logged.
    expect(result).not.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Backup pruning failed'));
  });
});

describe('listBackups', () => {
  it('returns sorted backups (newest first) with size and created time', () => {
    mockFs.existsSync.mockReturnValue(true); // backup dir exists
    mockFs.readdirSync.mockReturnValue([
      'dlvault-a.db',
      'dlvault-b.db',
      'unrelated.txt',
    ] as any);
    mockFs.statSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes('dlvault-a.db')) return { size: 100, mtime: new Date('2026-01-01T00:00:00Z') } as any;
      return { size: 200, mtime: new Date('2026-05-01T00:00:00Z') } as any;
    });

    const result = listBackups();
    expect(result).toHaveLength(2); // unrelated.txt filtered out
    // sorted by created desc → b (May) before a (Jan)
    expect(result[0].filename).toBe('dlvault-b.db');
    expect(result[0].size).toBe(200);
    expect(result[1].filename).toBe('dlvault-a.db');
  });

  it('creates the backup dir if missing', () => {
    mockFs.existsSync.mockReturnValue(false);
    listBackups();
    expect(mockFs.mkdirSync).toHaveBeenCalled();
  });

  it('returns an empty array when readdir throws', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation(() => { throw new Error('nope'); });
    expect(listBackups()).toEqual([]);
  });
});

describe('deleteBackup', () => {
  it('deletes a valid backup and its companions', () => {
    mockFs.existsSync.mockReturnValue(true); // file + wal + shm all present
    const ok = deleteBackup('dlvault-2026-01-01.db');
    expect(ok).toBe(true);
    const unlinked = mockFs.unlinkSync.mock.calls.map(c => String(c[0]));
    expect(unlinked.some(u => u.endsWith('dlvault-2026-01-01.db'))).toBe(true);
    expect(unlinked.some(u => u.endsWith('-wal'))).toBe(true);
    expect(unlinked.some(u => u.endsWith('-shm'))).toBe(true);
  });

  it('does not unlink absent companions', () => {
    // only the main .db file exists, no -wal/-shm
    mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('.db'));
    const ok = deleteBackup('dlvault-2026-01-01.db');
    expect(ok).toBe(true);
    expect(mockFs.unlinkSync).toHaveBeenCalledTimes(1);
  });

  it('rejects filenames not matching the dlvault-*.db pattern', () => {
    expect(deleteBackup('evil.txt')).toBe(false);
    expect(deleteBackup('dlvault-x.txt')).toBe(false);
    expect(deleteBackup('other-x.db')).toBe(false);
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('sanitises path traversal attempts via basename', () => {
    // basename('../../etc/passwd') = 'passwd' → fails the prefix check
    expect(deleteBackup('../../../etc/passwd')).toBe(false);
    // A traversal that still ends in a valid name resolves inside BACKUP_DIR
    mockFs.existsSync.mockReturnValue(true);
    deleteBackup('../../dlvault-evil.db');
    const unlinked = mockFs.unlinkSync.mock.calls.map(c => String(c[0]));
    // No '..' should survive — basename strips the traversal prefix.
    expect(unlinked.every(u => !u.includes('..'))).toBe(true);
  });

  it('returns false when the file does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(deleteBackup('dlvault-missing.db')).toBe(false);
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('startBackupScheduler / stopBackupScheduler', () => {
  it('does nothing when backup.enabled is not "true"', () => {
    mockSettings['backup.enabled'] = 'false';
    startBackupScheduler();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith('Backup scheduler disabled');
  });

  it('schedules with a cron expression derived from interval_hours', () => {
    mockSettings['backup.enabled'] = 'true';
    mockSettings['backup.interval_hours'] = '6';
    // listBackups returns >0 so no initial backup is created
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['dlvault-existing.db'] as any);

    startBackupScheduler();

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule.mock.calls[0][0]).toBe('0 */6 * * *');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('every 6h'));
  });

  it('clamps the interval hours to 23 in the cron expression', () => {
    mockSettings['backup.enabled'] = 'true';
    mockSettings['backup.interval_hours'] = '48';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['dlvault-existing.db'] as any);

    startBackupScheduler();
    expect(mockSchedule.mock.calls[0][0]).toBe('0 */23 * * *');
  });

  it('defaults interval to 24h when unset', () => {
    mockSettings['backup.enabled'] = 'true';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['dlvault-existing.db'] as any);

    startBackupScheduler();
    // min(24,23) → 23
    expect(mockSchedule.mock.calls[0][0]).toBe('0 */23 * * *');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('every 24h'));
  });

  it('creates an initial backup when none exist yet', () => {
    mockSettings['backup.enabled'] = 'true';
    // backup dir exists but is empty → listBackups() length 0 → initial backup
    mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('backups'));
    mockFs.readdirSync.mockReturnValue([] as any);

    startBackupScheduler();
    expect(mockFs.copyFileSync).toHaveBeenCalled(); // initial createBackup ran
  });

  it('does not create an initial backup when backups already exist', () => {
    mockSettings['backup.enabled'] = 'true';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['dlvault-existing.db'] as any);

    startBackupScheduler();
    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
  });

  it('stops a previously scheduled task when starting again', () => {
    mockSettings['backup.enabled'] = 'true';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['dlvault-existing.db'] as any);

    startBackupScheduler(); // schedules task 1
    startBackupScheduler(); // stop() called on task 1, schedules task 2
    expect(mockStop).toHaveBeenCalled();
    expect(mockSchedule).toHaveBeenCalledTimes(2);
  });

  it('the scheduled callback runs a backup', () => {
    mockSettings['backup.enabled'] = 'true';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['dlvault-existing.db'] as any);

    startBackupScheduler();
    const cb = mockSchedule.mock.calls[0][1] as () => void;
    cb();
    expect(mockFs.copyFileSync).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Running scheduled backup...');
  });

  it('stopBackupScheduler is a safe no-op when nothing is scheduled', () => {
    expect(() => stopBackupScheduler()).not.toThrow();
    expect(mockStop).not.toHaveBeenCalled();
  });
});
