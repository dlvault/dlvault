import cron, { type ScheduledTask } from 'node-cron';
import fs from 'fs';
import path from 'path';
import db, { getSetting } from '../database/index';
import { logger } from '../utils/logger';

const DATA_DIR = path.join(__dirname, '../../data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

let scheduledTask: ScheduledTask | null = null;

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

    // Serialize the live DB to a single consistent snapshot. Unlike a raw
    // copyFileSync of the WAL-mode file (where the newest commits live in the
    // -wal sidecar, so the copied main file alone is stale and copying the
    // sidecars separately is fragile per SQLite's own guidance), serialize()
    // returns a complete, self-contained database image — one file, no
    // -wal/-shm companions needed to restore.
    fs.writeFileSync(dest, db.serialize());

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

  const parsedHours = parseInt(getSetting('backup.interval_hours') || '24', 10);
  // Guard against NaN / <1 (would yield an invalid cron like "0 */NaN * * *"
  // that cron.schedule throws on). Mirror the main scheduler: a daily-or-longer
  // interval runs once at 03:00 instead of the broken "*/24"/"*/23" hour step
  // (which fires at hour 0 AND hour 23, i.e. not actually every 24h).
  const intervalHours = Number.isFinite(parsedHours) && parsedHours >= 1 ? parsedHours : 24;
  const cronExpr = intervalHours >= 24 ? '0 3 * * *' : `0 */${intervalHours} * * *`;
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
