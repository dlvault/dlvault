import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { initEncryption } from './encryption';
import { logger } from '../utils/logger';
import { applySchema } from './schema';
import { createSettingsStore, migrateLegacyCaptchaKey, migrateSettingsToEncrypted } from './settings';
// Imports nothing from this module (it runs before the DB exists) — no cycle.
import { applyPendingRestore } from '../services/restore';

const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'dlvault.db');

// A restore staged by the API is applied HERE — the last moment before the
// database file is opened. Once better-sqlite3 holds the handle, swapping the
// file underneath it leaves a live connection pointing at stale pages and a WAL
// that no longer matches. See services/restore.ts for the two-phase design.
const restoreSummary = applyPendingRestore();
if (restoreSummary) {
  logger.info(`Backup restore applied at startup: ${restoreSummary}`);
}

const db: DatabaseType = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// NORMAL is the recommended companion to WAL: it skips the per-commit fsync that
// FULL forces, which matters because a sync writes many small status updates. The
// DB stays consistent across app/OS crashes; only a hard power loss can drop the
// last transaction(s) — acceptable here, since the next sync re-derives state.
db.pragma('synchronous = NORMAL');
// Without busy_timeout the default is 0: a write that hits the momentary WAL
// write-lock held by another in-process async context (scheduler / postprocess /
// telegram / SSE all write here) fails instantly with SQLITE_BUSY and the write is
// lost. Wait up to 5s for the lock instead of throwing.
db.pragma('busy_timeout = 5000');

export function initDatabase(): void {
  applySchema(db);

  // Prune activity log — keep last 90 days (limit to avoid long locks on startup)
  db.exec(`DELETE FROM activity_log WHERE id IN (SELECT id FROM activity_log WHERE created_at < datetime('now', '-90 days') LIMIT 5000)`);

  // Initialize encryption key. Tell it whether ciphertext already exists, so a
  // missing key file is refused rather than silently replaced (which would make
  // every stored credential permanently unreadable).
  const ciphertextRow = db.prepare(
    "SELECT 1 AS present FROM settings WHERE value LIKE 'enc:%' LIMIT 1",
  ).get() as { present: number } | undefined;
  initEncryption(!!ciphertextRow);

  // Default settings
  const defaults: Record<string, string> = {
    'trakt.client_id': '',
    'trakt.client_secret': '',
    'trakt.access_token': '',
    'trakt.refresh_token': '',
    'trakt.username': '',
    'secret-store.2captcha-api-key': '',
    'watchlist.provider': 'trakt',
    'watchlist.remove_after_download': 'false',
    'mcp.enabled': 'false',
    'mcp.group.report': 'false',
    'mcp.group.heal': 'false',
    'mcp.group.library': 'false',
    'plex.token': '',
    'arr.enabled': 'false',
    'seerr.webhook_enabled': 'false',
    'seerr.issues_enabled': 'false',
    'seerr.webhook_token': '',
    'arr.api_key': '',
    'tmdb.api_key': '',
    'seerr.url': '',
    'seerr.api_key': '',
    'jellyfin.url': '',
    'jellyfin.api_key': '',
    'jdownloader.email': '',
    'jdownloader.password': '',
    'jdownloader.device_name': '',
    'quality.minimum': '',         // empty = Beste verfügbare (no min)
    'quality.maximum': '',         // empty = no max
    'quality.preferred': '2160p',
    'quality.audio_minimum': '',   // empty = Beste verfügbare (no min)
    'quality.series_override': 'false', // when true, shows use the series_* thresholds below instead of the global ones
    'quality.series_minimum': '',
    'quality.series_maximum': '',
    'quality.series_audio_minimum': '',
    'quality.language': 'german',
    'quality.language_strict': 'false', // when true, reject 'unknown'-language releases (only exact match) — wait for a real German release instead of grabbing an unmarked/foreign one
    'quality.exclude_types': 'complete,remux',
    'quality.prefer_hoster': 'false',   // first-choice hoster over a better quality (releaseChoice.ts)
    'quality.hdr_preference': 'hdr',    // 'hdr' | 'hdr_no_dv' | 'none' — HDR rank in the best-first sort (filter.ts)
    'quality.size_before_audio': 'false', // at equal resolution + HDR the bigger file wins before the audio rank (filter.ts)
    'paths.downloads': '/downloads',
    'paths.movies': '/movies',
    'paths.series': '/series',
    'paths.kids_movies': '',            // optional kids library — empty = off
    'paths.kids_series': '',
    'kids.genres': 'Family,Animation',  // genres that route a title to the kids library
    'scheduler.interval_hours': '24',
    'scheduler.enabled': 'true',
    'scheduler.release_hold': 'true',      // scheduled searches wait for the TMDb release date (releaseHold.ts)
    'scheduler.release_grace_days': '30',  // after a theatrical date without a digital one
    'scheduler.max_searches_per_hour': '0',      // scheduled searches per hour over all titles (0 = unlimited; searchBudget.ts)
    'scheduler.min_days_between_searches': '0',  // minimum days between two scheduled searches of one title (0 = off)
    'scheduler.loop_guard': 'false',             // do not search again while files of an already sent title sit in the download folder
    'quality.auto_upgrade': 'false',
    'quality.cutoff': '2160p',
    // The id marker makes Jellyfin/Plex identify by provider id instead of
    // guessing from the title — without it, "Grell (2020)" was matched to
    // Grell Island. Empty when the id is unknown; the template engine then drops
    // the marker. INSERT OR IGNORE: existing installs keep whatever they have,
    // and nothing is renamed retroactively.
    'rename.movie_file_template': '{title} ({year}) [imdbid-{imdbid}]',
    'rename.series_folder_template': '{title} [imdbid-{imdbid}]',
    'rename.series_file_template': '{title} S{season}E{episode}',
    'rename.junk_min_size_mb': '300',
    'bandwidth.schedule_enabled': 'false',
    'bandwidth.day_limit_kbps': '5000',
    'bandwidth.night_limit_kbps': '0',
    'bandwidth.day_start': '08',
    'bandwidth.day_end': '23',
    'telegram.bot_token': '',
    'telegram.enabled': 'false',
    'telegram.allowed_chat_ids': '',
    'telegram.release_choice': 'false',   // ask the admin chat when quality and first-choice hoster disagree (releaseChoice.ts)
    'telegram.limited_chat_ids': '',      // chats that only get found/downloading/done for their own requests (telegram.ts)
    'telegram.system_alerts_admin_only': 'false', // health/source/JD alerts go to the admin chat only
    'omdb.api_key': '',
    // On by default for new installs: an instance with no backup at all was
    // the common state — the setting existed, nobody turned it on.
    'backup.enabled': 'true',
    'backup.interval_hours': '24',
    'backup.max_backups': '5',
    // Empty = data/backups. Point this at another share/mount so a lost data
    // volume doesn't take the database AND every backup with it.
    'backup.path': '',
    // Docker container to restart when JD has dropped off MyJDownloader for
    // 15 min (jdAutoRestart.ts). Empty = never restart anything.
    'jdownloader.container_name': '',
    // Optional second copy of every backup on another disk/share. Empty = off.
    'backup.mirror_path': '',
    // The encryption key travels inside the archive by default — without it the
    // stored credentials are unreadable ciphertext and the backup cannot
    // actually restore a working instance. Turn off to keep the key separate,
    // accepting that credentials must then be re-entered after a restore.
    'backup.include_key': 'true',
  };

  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );

  const insertMany = db.transaction(() => {
    for (const [key, value] of Object.entries(defaults)) {
      insertSetting.run(key, value);
    }
  });
  insertMany();

  // Migrate empty path defaults to container paths (for existing DBs)
  const pathDefaults: Record<string, string> = {
    'paths.downloads': '/downloads',
    'paths.movies': '/movies',
    'paths.series': '/series',
  };
  const updateEmpty = db.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?');
  for (const [key, value] of Object.entries(pathDefaults)) {
    updateEmpty.run(value, key, '');
  }

  migrateLegacyCaptchaKey(db);
  migrateSettingsToEncrypted(db);
}

// The settings layer proper lives in ./settings — see the note there on why it
// takes a `db` instead of reaching for this module's.
const settings = createSettingsStore(db);

export function getSetting(key: string): string {
  return settings.get(key);
}

export function setSetting(key: string, value: string): void {
  settings.set(key, value);
}

export function getAllSettings(): Record<string, string> {
  return settings.getAll();
}

export function closeDatabase(): void {
  try {
    db.close();
  } catch {
    // Already closed or never opened
  }
}

export { db };
export default db;
