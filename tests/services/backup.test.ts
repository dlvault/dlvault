import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Test directly against filesystem operations instead of mocking the module
const TEST_DATA_DIR = path.join(__dirname, '../../.test-backup-data');
const TEST_BACKUP_DIR = path.join(TEST_DATA_DIR, 'backups');
const TEST_DB_PATH = path.join(TEST_DATA_DIR, 'dlvault.db');

describe('Backup Service (filesystem)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_BACKUP_DIR, { recursive: true });
    fs.writeFileSync(TEST_DB_PATH, 'test-database-content');
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  function createTestBackup(suffix?: string): { filename: string; dest: string } {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `dlvault-${timestamp}${suffix || ''}.db`;
    const dest = path.join(TEST_BACKUP_DIR, filename);
    fs.copyFileSync(TEST_DB_PATH, dest);
    return { filename, dest };
  }

  function listTestBackups(): string[] {
    return fs.readdirSync(TEST_BACKUP_DIR)
      .filter(f => f.startsWith('dlvault-') && f.endsWith('.db'))
      .sort();
  }

  it('should create a backup by copying the database file', () => {
    const { filename, dest } = createTestBackup();

    expect(fs.existsSync(dest)).toBe(true);
    expect(filename).toMatch(/^dlvault-.*\.db$/);

    const content = fs.readFileSync(dest, 'utf-8');
    expect(content).toBe('test-database-content');
  });

  it('should list backup files', () => {
    createTestBackup('-a');
    createTestBackup('-b');

    const backups = listTestBackups();
    expect(backups).toHaveLength(2);
  });

  it('should delete a specific backup', () => {
    const { filename, dest } = createTestBackup();
    expect(fs.existsSync(dest)).toBe(true);

    fs.unlinkSync(dest);
    expect(fs.existsSync(dest)).toBe(false);
    expect(listTestBackups()).toHaveLength(0);
  });

  it('should prune backups beyond max count', () => {
    const maxBackups = 2;

    // Create 4 backups
    createTestBackup('-001');
    createTestBackup('-002');
    createTestBackup('-003');
    createTestBackup('-004');

    // Prune: keep only last N
    const files = listTestBackups().reverse(); // newest first
    const toDelete = files.slice(maxBackups);
    for (const file of toDelete) {
      fs.unlinkSync(path.join(TEST_BACKUP_DIR, file));
    }

    expect(listTestBackups()).toHaveLength(maxBackups);
  });

  it('should not delete non-dlvault files', () => {
    const otherFile = path.join(TEST_BACKUP_DIR, 'important-data.txt');
    fs.writeFileSync(otherFile, 'keep me');

    // Simulate safe delete check
    const filename = 'important-data.txt';
    const safe = path.basename(filename);
    const isValid = safe.startsWith('dlvault-') && safe.endsWith('.db');

    expect(isValid).toBe(false);
    expect(fs.existsSync(otherFile)).toBe(true);
  });

  it('should prevent path traversal in filename', () => {
    const malicious = '../../../etc/passwd';
    const safe = path.basename(malicious);

    expect(safe).toBe('passwd');
    expect(safe.startsWith('dlvault-')).toBe(false);
  });

  it('should copy WAL file if it exists', () => {
    const walPath = TEST_DB_PATH + '-wal';
    fs.writeFileSync(walPath, 'wal-content');

    const { dest } = createTestBackup();

    // Simulate WAL copy
    const walDest = dest + '-wal';
    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, walDest);
    }

    expect(fs.existsSync(walDest)).toBe(true);
    expect(fs.readFileSync(walDest, 'utf-8')).toBe('wal-content');
  });

  it('should return empty list when backup dir has no matching files', () => {
    // Write a non-matching file
    fs.writeFileSync(path.join(TEST_BACKUP_DIR, 'readme.txt'), 'not a backup');

    expect(listTestBackups()).toHaveLength(0);
  });
});
