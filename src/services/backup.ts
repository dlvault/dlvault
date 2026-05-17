import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { getSetting } from '../database/index';
import { logger } from '../utils/logger';

const DATA_DIR = path.join(__dirname, '../../data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_PATH = path.join(DATA_DIR, 'dlvault.db');

let scheduledTask: cron.ScheduledTask | null = null;

function ensureBackupDir(): void {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

export function createBackup(): { filename: string; size: number } | null {
  try {
    ensureBackupDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `dlvault-${timestamp}.db`;
    const dest = path.join(BACKUP_DIR, filename);

    // Copy the database file (SQLite WAL mode safe: copy main file)
    fs.copyFileSync(DB_PATH, dest);

    // Also copy WAL/SHM if they exist (for consistency)
    const walPath = DB_PATH + '-wal';
    const shmPath = DB_PATH + '-shm';
    if (fs.existsSync(walPath)) fs.copyFileSync(walPath, dest + '-wal');
    if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, dest + '-shm');

    const stats = fs.statSync(dest);
    logger.info(`Backup created: ${filename} (${Math.round(stats.size / 1024)}KB)`);

    // Cleanup old backups
    pruneBackups();

    return { filename, size: stats.size };
  } catch (error: any) {
    logger.error(`Backup failed: ${error.message}`);
    return null;
  }
}

function pruneBackups(): void {
  const maxBackups = parseInt(getSetting('backup.max_backups') || '5', 10);
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('dlvault-') && f.endsWith('.db'))
      .sort()
      .reverse();

    // Keep only max_backups, delete the rest
    const toDelete = files.slice(maxBackups);
    for (const file of toDelete) {
      fs.unlinkSync(path.join(BACKUP_DIR, file));
      // Also remove WAL/SHM companions
      const wal = path.join(BACKUP_DIR, file + '-wal');
      const shm = path.join(BACKUP_DIR, file + '-shm');
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
      logger.debug(`Pruned old backup: ${file}`);
    }
  } catch (error: any) {
    logger.error(`Backup pruning failed: ${error.message}`);
  }
}

export function listBackups(): { filename: string; size: number; created: string }[] {
  ensureBackupDir();
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('dlvault-') && f.endsWith('.db'))
      .map(f => {
        const stats = fs.statSync(path.join(BACKUP_DIR, f));
        return { filename: f, size: stats.size, created: stats.mtime.toISOString() };
      })
      .sort((a, b) => b.created.localeCompare(a.created));
  } catch {
    return [];
  }
}

export function deleteBackup(filename: string): boolean {
  // Sanitize filename to prevent path traversal
  const safe = path.basename(filename);
  if (!safe.startsWith('dlvault-') || !safe.endsWith('.db')) return false;

  const filePath = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(filePath)) return false;

  fs.unlinkSync(filePath);
  const wal = filePath + '-wal';
  const shm = filePath + '-shm';
  if (fs.existsSync(wal)) fs.unlinkSync(wal);
  if (fs.existsSync(shm)) fs.unlinkSync(shm);
  logger.info(`Backup deleted: ${safe}`);
  return true;
}

export function startBackupScheduler(): void {
  stopBackupScheduler();

  const enabled = getSetting('backup.enabled');
  if (enabled !== 'true') {
    logger.debug('Backup scheduler disabled');
    return;
  }

  const intervalHours = parseInt(getSetting('backup.interval_hours') || '24', 10);

  // Run every N hours
  const cronExpr = `0 */${Math.min(intervalHours, 23)} * * *`;
  scheduledTask = cron.schedule(cronExpr, () => {
    logger.info('Running scheduled backup...');
    createBackup();
  });

  logger.info(`Backup scheduler started (every ${intervalHours}h)`);

  // Create initial backup if none exist
  if (listBackups().length === 0) {
    createBackup();
  }
}

export function stopBackupScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}
