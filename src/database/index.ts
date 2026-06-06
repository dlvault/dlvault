import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { isSensitiveKey, isEncrypted, encrypt, decrypt, initEncryption } from './encryption';
import { logger } from '../utils/logger';

const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'dlvault.db');

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trakt_id INTEGER UNIQUE,
      imdb_id TEXT,
      tmdb_id INTEGER,
      title TEXT NOT NULL,
      year INTEGER,
      slug TEXT,
      media_type TEXT NOT NULL DEFAULT 'movie',
      status TEXT NOT NULL DEFAULT 'pending',
      desired_quality TEXT DEFAULT '2160p',
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_url TEXT,
      last_checked_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      plot TEXT,
      genres TEXT,
      rating REAL,
      runtime INTEGER,
      director TEXT,
      studio TEXT,
      country TEXT,
      metadata_fetched_at TEXT,
      not_found_reason TEXT,
      season_cutoff INTEGER
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER NOT NULL,
      season_number INTEGER,
      release_name TEXT,
      quality TEXT,
      audio TEXT,
      hoster TEXT NOT NULL DEFAULT '',
      download_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      jdownloader_package_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      desired_quality TEXT DEFAULT '2160p',
      source_url TEXT,
      last_checked_at TEXT,
      episode_count INTEGER DEFAULT NULL,
      aired_episodes INTEGER DEFAULT NULL,
      not_found_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE,
      UNIQUE(movie_id, season_number)
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id INTEGER NOT NULL,
      episode_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      release_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE,
      UNIQUE(season_id, episode_number)
    );

    CREATE TABLE IF NOT EXISTS blocklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      release_name TEXT NOT NULL,
      title TEXT,
      reason TEXT,
      movie_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE SET NULL
    );
  `);

  // Migrations for existing databases
  const columns = db.prepare("PRAGMA table_info(movies)").all() as { name: string }[];
  if (!columns.find(c => c.name === 'media_type')) {
    db.exec("ALTER TABLE movies ADD COLUMN media_type TEXT NOT NULL DEFAULT 'movie'");
  }
  if (!columns.find(c => c.name === 'retry_count')) {
    db.exec("ALTER TABLE movies ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.find(c => c.name === 'last_retry_at')) {
    db.exec("ALTER TABLE movies ADD COLUMN last_retry_at TEXT");
  }
  // Tracks the last time the status-sync confirmed this movie's JD package was
  // present (in download list or linkgrabber). Distinct from updated_at, which
  // only moves on state transitions — so a long-lived 'downloading' row with
  // updated_at = added_at can still report a fresh JD check.
  if (!columns.find(c => c.name === 'last_jd_check_at')) {
    db.exec("ALTER TABLE movies ADD COLUMN last_jd_check_at TEXT");
  }
  // When this movie's status first reached 'downloaded' (i.e. landed in the
  // library). Distinct from added_at (watchlist add) and last_checked_at (moves
  // on every search) — the dashboard's "recently added" / "last finished" need a
  // timestamp that does NOT shift when the scheduler merely re-searches a show.
  // NULL for items downloaded before this column existed → frontend falls back
  // to added_at for those.
  if (!columns.find(c => c.name === 'downloaded_at')) {
    db.exec("ALTER TABLE movies ADD COLUMN downloaded_at TEXT");
  }
  // Media metadata (plot/genres/rating/...) — populated lazily from OMDb on first detail view.
  for (const [name, type] of [
    ['plot', 'TEXT'], ['genres', 'TEXT'], ['rating', 'REAL'], ['runtime', 'INTEGER'],
    ['director', 'TEXT'], ['studio', 'TEXT'], ['country', 'TEXT'], ['metadata_fetched_at', 'TEXT'],
  ] as const) {
    if (!columns.find(c => c.name === name)) {
      db.exec(`ALTER TABLE movies ADD COLUMN ${name} ${type}`);
    }
  }

  // Sub-classification of the 'not_found' status so the UI can split the single
  // "Nicht gefunden" bucket into: not at any source (not_available), at the
  // source but no downloadable file/links (no_download), or releases present but
  // failing the quality filter (quality_mismatch). status stays 'not_found' — this
  // is purely additive so all retry/count/Telegram logic keeps working untouched.
  // On the boot that first adds the column, backfill from the most recent relevant
  // activity_log action so existing rows are bucketed correctly without waiting for
  // the next sync to re-classify them.
  if (!columns.find(c => c.name === 'not_found_reason')) {
    db.exec("ALTER TABLE movies ADD COLUMN not_found_reason TEXT");
    db.exec(`
      UPDATE movies SET not_found_reason = (
        SELECT CASE al.action
          WHEN 'quality_mismatch' THEN 'quality_mismatch'
          WHEN 'no_hoster'        THEN 'no_download'
          WHEN 'links_offline'    THEN 'no_download'
          ELSE 'not_available' END
        FROM activity_log al
        WHERE al.movie_id = movies.id
          AND al.action IN ('not_found', 'quality_mismatch', 'no_hoster', 'links_offline')
        ORDER BY al.created_at DESC, al.id DESC LIMIT 1)
      WHERE status = 'not_found'
    `);
  }

  // Per-show "download only from season N onwards" cutoff. NULL = monitor all
  // seasons (the pre-existing behaviour). When set to N, the scheduler skips
  // every season below N — and Trakt sync stops re-adding them — so a long
  // back-catalogue (e.g. a 20-season soap) never gets fetched. Seasons already
  // downloading/downloaded below the cutoff are left untouched; the cutoff only
  // stops further work. Reversible: it's a pure filter, no season rows mutated.
  if (!columns.find(c => c.name === 'season_cutoff')) {
    db.exec("ALTER TABLE movies ADD COLUMN season_cutoff INTEGER");
  }

  // Set while the integrity check ("Endkontrolle") is re-downloading a title whose
  // library file was found incomplete — so the queue can show a small "Reparatur"
  // badge instead of looking like a random re-download. Cleared the moment the
  // title next reaches 'downloaded' (see updateMovieStatus).
  if (!columns.find(c => c.name === 'repair')) {
    db.exec("ALTER TABLE movies ADD COLUMN repair INTEGER NOT NULL DEFAULT 0");
  }

  // Per-title quality-filter override for the "Anforderungen nicht erfüllt"
  // (quality_mismatch) bucket: the user explicitly wants this title even though
  // every release fails the configured floor. NULL = global filter (default),
  // 'relaxed' = drop minimum-resolution/audio + type exclusions but keep the
  // language requirement, 'any' = accept every release that has links. Shows
  // inherit the override for all their seasons (the filter runs per show).
  // The best-first sort still wins, so a conforming release is always preferred.
  if (!columns.find(c => c.name === 'quality_override')) {
    db.exec("ALTER TABLE movies ADD COLUMN quality_override TEXT");
  }

  // Migrations for seasons table
  const seasonCols = db.prepare("PRAGMA table_info(seasons)").all() as { name: string }[];
  if (!seasonCols.find(c => c.name === 'episode_count')) {
    db.exec("ALTER TABLE seasons ADD COLUMN episode_count INTEGER DEFAULT NULL");
  }
  if (!seasonCols.find(c => c.name === 'aired_episodes')) {
    db.exec("ALTER TABLE seasons ADD COLUMN aired_episodes INTEGER DEFAULT NULL");
  }
  if (!seasonCols.find(c => c.name === 'not_found_reason')) {
    db.exec("ALTER TABLE seasons ADD COLUMN not_found_reason TEXT");
  }

  // Migrations for downloads table. season_number ties a download row to a
  // specific show season so the 'found'-season JD retry only re-sends that
  // season's links (NULL for movies / legacy rows).
  const downloadCols = db.prepare("PRAGMA table_info(downloads)").all() as { name: string }[];
  if (!downloadCols.find(c => c.name === 'season_number')) {
    db.exec("ALTER TABLE downloads ADD COLUMN season_number INTEGER");
  }

  // Performance indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_movies_status ON movies(status);
    CREATE INDEX IF NOT EXISTS idx_movies_media_type ON movies(media_type);
    CREATE INDEX IF NOT EXISTS idx_movies_imdb_id ON movies(imdb_id);
    CREATE INDEX IF NOT EXISTS idx_movies_tmdb_id ON movies(tmdb_id);
    CREATE INDEX IF NOT EXISTS idx_downloads_movie_id ON downloads(movie_id);
    CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
    CREATE INDEX IF NOT EXISTS idx_activity_log_movie_id ON activity_log(movie_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_seasons_movie_id ON seasons(movie_id);
    CREATE INDEX IF NOT EXISTS idx_seasons_status ON seasons(status);
    CREATE INDEX IF NOT EXISTS idx_episodes_season_id ON episodes(season_id);
    CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
    CREATE INDEX IF NOT EXISTS idx_episodes_season_status ON episodes(season_id, status);
    CREATE INDEX IF NOT EXISTS idx_activity_movie_created ON activity_log(movie_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_blocklist_release_name ON blocklist(release_name);
  `);

  // Enforce uniqueness on (movie_id, download_url) so concurrent addDownload calls
  // can't create duplicate rows (which would double-send the same links to JD).
  // De-dup any pre-existing duplicates FIRST (keep the oldest row per key), else
  // CREATE UNIQUE INDEX would throw on a legacy DB. Idempotent: after the first
  // run the DELETE matches nothing and the index already exists.
  db.exec(`
    DELETE FROM downloads WHERE id NOT IN (
      SELECT MIN(id) FROM downloads GROUP BY movie_id, download_url
    );
    DROP INDEX IF EXISTS idx_downloads_movie_url;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_downloads_movie_url ON downloads(movie_id, download_url);
  `);

  // Prune activity log — keep last 90 days (limit to avoid long locks on startup)
  db.exec(`DELETE FROM activity_log WHERE id IN (SELECT id FROM activity_log WHERE created_at < datetime('now', '-90 days') LIMIT 5000)`);

  // Initialize encryption key
  initEncryption();

  // Default settings
  const defaults: Record<string, string> = {
    'trakt.client_id': '',
    'trakt.client_secret': '',
    'trakt.access_token': '',
    'trakt.refresh_token': '',
    'trakt.username': '',
    'secret-store.2captcha-api-key': '',
    'watchlist.provider': 'trakt',
    'plex.token': '',
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
    'paths.downloads': '/downloads',
    'paths.movies': '/movies',
    'paths.series': '/series',
    'paths.kids_movies': '',            // optional kids library — empty = off
    'paths.kids_series': '',
    'kids.genres': 'Family,Animation',  // genres that route a title to the kids library
    'scheduler.interval_hours': '24',
    'scheduler.enabled': 'true',
    'quality.auto_upgrade': 'false',
    'quality.cutoff': '2160p',
    'rename.movie_file_template': '{title} ({year})',
    'rename.series_folder_template': '{title}',
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
    'omdb.api_key': '',
    'backup.enabled': 'false',
    'backup.interval_hours': '24',
    'backup.max_backups': '5',
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

  // One-time migration: existing `captcha.twocaptcha_key` rows pre-date the
  // generic plugin-secrets system and need to move under `secret-store.*` so
  // the captcha concept is removed from the core's vocabulary. Copy the value
  // (still encrypted at rest) and delete the old row.
  migrateLegacyCaptchaKey();

  // Migrate plaintext sensitive values to encrypted
  migrateToEncrypted();
}

function migrateLegacyCaptchaKey(): void {
  const legacyRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('captcha.twocaptcha_key') as { value: string } | undefined;
  if (!legacyRow) return;
  const newRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('secret-store.2captcha-api-key') as { value: string } | undefined;
  if (newRow && newRow.value) {
    // New key already populated — just drop the legacy row.
    db.prepare("DELETE FROM settings WHERE key = ?").run('captcha.twocaptcha_key');
    return;
  }
  if (legacyRow.value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('secret-store.2captcha-api-key', legacyRow.value);
  }
  db.prepare("DELETE FROM settings WHERE key = ?").run('captcha.twocaptcha_key');
}

function migrateToEncrypted(): void {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  const migrate = db.transaction(() => {
    for (const row of rows) {
      if (isSensitiveKey(row.key) && row.value && !isEncrypted(row.value)) {
        update.run(encrypt(row.value), row.key);
      }
    }
  });
  migrate();
}

// In-memory settings cache — invalidated on setSetting()
let settingsCache: Record<string, string> | null = null;

function loadSettingsCache(): Record<string, string> {
  if (!settingsCache) {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    settingsCache = {};
    for (const row of rows) {
      if (!isSensitiveKey(row.key)) {
        settingsCache[row.key] = row.value;
        continue;
      }
      try {
        settingsCache[row.key] = decrypt(row.value);
      } catch (err: any) {
        // A single undecryptable secret (corrupted ciphertext, or a lost/rotated
        // encryption key — plausible after a volume misconfig) must NOT throw out
        // of here: getSetting()/getAllSettings() are called everywhere, so a throw
        // would brick the whole app. Degrade just that key to empty and continue.
        logger.warn(`Failed to decrypt setting "${row.key}" — treating as empty (${err?.message || err})`);
        settingsCache[row.key] = '';
      }
    }
  }
  return settingsCache;
}

export function getSetting(key: string): string {
  const cache = loadSettingsCache();
  return cache[key] ?? '';
}

export function setSetting(key: string, value: string): void {
  const storedValue = isSensitiveKey(key) && value ? encrypt(value) : value;
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, storedValue);
  // Surgically update the cache for this key — invalidating the whole cache
  // forced a fresh disk read of every setting on the next get(), which adds
  // up during a sync that touches dozens of settings per movie.
  if (settingsCache) {
    settingsCache[key] = value;
  }
}

export function getAllSettings(): Record<string, string> {
  return { ...loadSettingsCache() };
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
