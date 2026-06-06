import cron, { type ScheduledTask } from 'node-cron';
import fs from 'fs';
import path from 'path';
import db, { getSetting } from '../database/index';
import { logger } from '../utils/logger';
import { getAppVersion } from '../utils/version';
import Database from 'better-sqlite3';
import { buildTarGz, readTarGz, type ArchiveEntry } from './backupArchive';

const DATA_DIR = path.join(__dirname, '../../data');
const DEFAULT_BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEY_FILE = path.join(DATA_DIR, '.key');
const PLUGINS_DIR = path.join(DATA_DIR, 'plugins');

/** Current archive format. Bumped if the layout inside the .tar.gz changes. */
const ARCHIVE_VERSION = 1;

let scheduledTask: ScheduledTask | null = null;

/**
 * Where backups are written.
 *
 * Defaults to `data/backups` — but that sits in the SAME volume as the database
 * it protects, so a lost or corrupted volume takes the database and every backup
 * with it. `backup.path` lets the user point this at another share, an external
 * mount, or a cloud-synced folder, which is what turns a snapshot into a backup.
 */
export function backupDir(): string {
  const configured = (getSetting('backup.path') || '').trim();
  return configured ? path.resolve(configured) : DEFAULT_BACKUP_DIR;
}

/**
 * An archive holds the database AND the encryption key — every stored
 * credential. Backup folders often sit on a network share other accounts can
 * read (a media share for the TV, an exported appdata), so files and folders
 * are owner-only. chmod is best effort: some filesystems ignore it.
 */
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;
function makePrivate(p: string, mode: number): void {
  try { fs.chmodSync(p, mode); } catch { /* filesystem without unix modes */ }
}

function ensureBackupDir(): string {
  const dir = backupDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
  }
  makePrivate(dir, PRIVATE_DIR);
  return dir;
}

/** Both the current archive format and the legacy bare-database backups. */
function isBackupFile(name: string): boolean {
  return name.startsWith('dlvault-') && (name.endsWith('.tar.gz') || name.endsWith('.db'));
}

export function createBackup(): { filename: string; size: number } | null {
  try {
    const dir = ensureBackupDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `dlvault-${timestamp}.tar.gz`;
    const dest = path.join(dir, filename);

    const entries: ArchiveEntry[] = [];

    // Serialize the live DB to a single consistent snapshot. Unlike a raw copy
    // of the WAL-mode file (where the newest commits live in the -wal sidecar,
    // so the copied main file alone is stale and copying the sidecars
    // separately is fragile per SQLite's own guidance), serialize() returns a
    // complete, self-contained database image. This carries every table:
    // settings, movies, downloads, seasons, episodes, blocklist, activity_log.
    entries.push({ name: 'dlvault.db', content: db.serialize() });

    // The encryption key. Without it the credentials in the database above are
    // unreadable ciphertext, so a backup that omits it cannot actually restore
    // a working instance — which is exactly the trap the old bare-.db backup
    // set. Opt-out for anyone who would rather keep the key separate.
    const includeKey = getSetting('backup.include_key') !== 'false';
    let keyIncluded = false;
    if (includeKey && fs.existsSync(KEY_FILE)) {
      entries.push({ name: 'key', content: fs.readFileSync(KEY_FILE), mode: 0o600 });
      keyIncluded = true;
    }

    // Installed plugins + the disclaimer log that marks them accepted. dlvault
    // ships no sources of its own, so without these a restored instance comes
    // back with no way to find anything.
    let pluginCount = 0;
    if (fs.existsSync(PLUGINS_DIR)) {
      for (const name of fs.readdirSync(PLUGINS_DIR)) {
        if (!name.endsWith('.dlvault.js') && name !== 'disclaimer-log.json') continue;
        const full = path.join(PLUGINS_DIR, name);
        try {
          if (!fs.statSync(full).isFile()) continue;
          entries.push({ name: `plugins/${name}`, content: fs.readFileSync(full) });
          if (name.endsWith('.dlvault.js')) pluginCount++;
        } catch { /* unreadable — skip rather than fail the whole backup */ }
      }
    }

    // Self-describing, so a restore can validate what it is looking at and a
    // human opening the archive can tell what it contains.
    entries.push({
      name: 'manifest.json',
      content: Buffer.from(JSON.stringify({
        archiveVersion: ARCHIVE_VERSION,
        createdAt: new Date().toISOString(),
        appVersion: getAppVersion(),
        includesKey: keyIncluded,
        pluginCount,
        contents: entries.map(e => e.name),
        restoreHint:
          'Restore via dlvault: Einstellungen → Backup → Wiederherstellen. '
          + 'Manuell: Container stoppen, dlvault.db / key / plugins in das data-Volume entpacken '
          + '(key → data/.key, plugins/* → data/plugins/), Container starten.',
      }, null, 2)),
    });

    // Atomic write: build the archive, write to a temp file, then rename into
    // place. A crash mid-write leaves a stray .tmp (ignored by listBackups)
    // instead of a truncated archive that could be picked for a restore.
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, buildTarGz(entries), { mode: PRIVATE_FILE });
    fs.renameSync(tmp, dest);
    makePrivate(dest, PRIVATE_FILE);

    const stats = fs.statSync(dest);
    logger.info(
      `Backup created: ${filename} (${Math.round(stats.size / 1024)}KB) — database`
      + `${keyIncluded ? ' + key' : ''}${pluginCount > 0 ? ` + ${pluginCount} plugin(s)` : ''} → ${dir}`,
    );

    // A backup nobody ever tried to read is a hope, not a backup. Open what was
    // just written the way a restore would, and say so loudly if it is broken.
    const check = verifyBackupArchive(dest);
    if (!check.ok) {
      logger.error(`Backup verification FAILED for ${filename}: ${check.detail}`);
      import('./telegram')
        .then(({ sendTelegramSystemAlert }) => sendTelegramSystemAlert(`🚨 <b>dlvault Backup</b>\nDas neue Backup ${filename} ist nicht lesbar: ${check.detail}`))
        .catch(() => { /* best effort */ });
    } else {
      logger.info(`Backup verified: ${check.detail}`);
    }

    mirrorBackup(dest, filename);

    // Cleanup old backups
    pruneBackups();

    return { filename, size: stats.size };
  } catch (error: any) {
    logger.error(`Backup failed: ${error.message}`);
    return null;
  }
}

/**
 * Can this archive be restored? Reads it the way stageRestore does, then opens
 * the contained database in memory and runs SQLite's own integrity check.
 */
export function verifyBackupArchive(file: string): { ok: boolean; detail: string } {
  try {
    const entries = readTarGz(fs.readFileSync(file));
    const byName = new Map(entries.map(e => [e.name, e.content]));
    if (!byName.has('manifest.json')) return { ok: false, detail: 'manifest.json fehlt' };
    const dbBuf = byName.get('dlvault.db');
    if (!dbBuf || dbBuf.subarray(0, 15).toString('ascii') !== 'SQLite format 3') {
      return { ok: false, detail: 'keine gültige Datenbank im Archiv' };
    }
    // The live database runs in WAL mode, and SQLite refuses to open a WAL
    // image from memory. Bytes 18/19 are the file-format read/write versions
    // (2 = WAL, 1 = rollback journal); a copy switched to 1 opens normally.
    const image = Buffer.from(dbBuf);
    image[18] = 1;
    image[19] = 1;
    const mem = new Database(image);
    try {
      const integrity = mem.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') return { ok: false, detail: `Integritätsprüfung: ${integrity}` };
      const movies = (mem.prepare('SELECT COUNT(*) AS n FROM movies').get() as { n: number }).n;
      return { ok: true, detail: `${movies} Titel, Integrität ok` };
    } finally {
      mem.close();
    }
  } catch (err: any) {
    return { ok: false, detail: err?.message || String(err) };
  }
}

/**
 * A second copy on another disk or share (backup.mirror_path). One copy next
 * to the database it protects goes down with the same disk. Pruned alike.
 */
function mirrorBackup(src: string, filename: string): void {
  const mirror = (getSetting('backup.mirror_path') || '').trim();
  if (!mirror) return;
  try {
    const dir = path.resolve(mirror);
    if (dir === backupDir()) return;
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
    makePrivate(dir, PRIVATE_DIR);
    const tmp = path.join(dir, `${filename}.tmp`);
    fs.copyFileSync(src, tmp);
    makePrivate(tmp, PRIVATE_FILE);
    fs.renameSync(tmp, path.join(dir, filename));
    pruneDir(dir);
    logger.info(`Backup mirrored → ${dir}`);
  } catch (err: any) {
    logger.error(`Backup mirror to ${mirror} failed: ${err.message}`);
  }
}

function pruneBackups(): void {
  pruneDir(backupDir());
}

function pruneDir(dirToPrune: string): void {
  // `slice(n)` with n = 0 (user typed "0") or NaN (non-numeric / empty-ish value)
  // is `slice(0)` — the WHOLE list — so the prune deleted every backup including
  // the one just written. The settings route stores this value unvalidated, so
  // the floor has to live here.
  const raw = parseInt(getSetting('backup.max_backups') || '5', 10);
  const maxBackups = Number.isFinite(raw) && raw >= 1 ? raw : 5;
  try {
    const dir = dirToPrune;
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir)
      .filter(isBackupFile)
      .sort()
      .reverse();

    // Keep only max_backups, delete the rest
    const toDelete = files.slice(maxBackups);
    for (const file of toDelete) {
      fs.unlinkSync(path.join(dir, file));
      // Legacy bare-.db backups could have WAL/SHM companions; archives never do.
      const wal = path.join(dir, file + '-wal');
      const shm = path.join(dir, file + '-shm');
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
      logger.debug(`Pruned old backup: ${file}`);
    }
  } catch (error: any) {
    logger.error(`Backup pruning failed: ${error.message}`);
  }
}

export function listBackups(): { filename: string; size: number; created: string; legacy: boolean }[] {
  const dir = ensureBackupDir();
  try {
    return fs.readdirSync(dir)
      .filter(isBackupFile)
      .map(f => {
        const stats = fs.statSync(path.join(dir, f));
        return {
          filename: f,
          size: stats.size,
          created: stats.mtime.toISOString(),
          // Bare .db files predate the archive format: database only, no key
          // and no plugins. Flagged so the UI can say so before a restore.
          legacy: f.endsWith('.db'),
        };
      })
      .sort((a, b) => b.created.localeCompare(a.created));
  } catch {
    return [];
  }
}

/** Absolute path of a backup, or null when the name is not a valid backup file. */
export function resolveBackupPath(filename: string): string | null {
  const safe = path.basename(filename);
  if (!isBackupFile(safe)) return null;
  const full = path.join(backupDir(), safe);
  return fs.existsSync(full) ? full : null;
}

export function deleteBackup(filename: string): boolean {
  // Sanitize filename to prevent path traversal
  const safe = path.basename(filename);
  if (!isBackupFile(safe)) return false;

  const filePath = path.join(backupDir(), safe);
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
