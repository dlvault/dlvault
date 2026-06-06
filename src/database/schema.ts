import type { Database as DatabaseType } from 'better-sqlite3';
import { logger } from '../utils/logger';

/**
 * Creates every table, column, and index dlvault needs, and brings an older
 * database up to the current shape. Idempotent — safe to run on every boot.
 *
 * This lives apart from `index.ts` on purpose. That module opens the real
 * database file at import time, so the test suite mocks it wholesale — which
 * meant the schema and all thirteen migrations were never executed by a single
 * test, and every DB test hand-copied its own CREATE TABLE. Those copies had
 * drifted badly (production `movies` has 33 columns; the fixtures had 14–17, so
 * features like `quality_override` and `season_cutoff` could not be tested at
 * all). Taking a `db` parameter lets the tests build their in-memory database
 * from this exact source, so the two cannot diverge again.
 *
 * Deliberately excluded: anything needing the encryption key, the settings
 * defaults, and the activity-log prune. Those are boot concerns, not schema,
 * and they stay in `initDatabase()`.
 */
export function applySchema(db: DatabaseType): void {
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

  // Which watchlist an entry came from: 'trakt', 'plex' or 'manual' (NULL for
  // rows predating this column).
  //
  // Before this existed, the Plex sync stuffed the TMDb id into `trakt_id` "as a
  // unique identifier substitute". Two id namespaces then shared one UNIQUE
  // column, with three consequences: Plex shows were seeded with the season
  // structure of whatever Trakt show happened to carry that number, a Plex title
  // could collide with an unrelated Trakt row and be silently skipped forever,
  // and — worst — Trakt's deletion sweep saw a non-NULL `trakt_id` that wasn't in
  // the Trakt watchlist and deleted the entry, every cycle, in `both` mode.
  // Provenance is the fact that was actually missing, so record it explicitly.
  // A watchlist show means "I want this show" — new seasons should be picked up
  // automatically. A Seerr request means "I want these seasons" and must not be
  // widened behind the requester's back. Without this flag, requesting S1+S2 of
  // an eight-season show queued all eight.
  if (!columns.find(c => c.name === 'seasons_explicit')) {
    db.exec("ALTER TABLE movies ADD COLUMN seasons_explicit INTEGER DEFAULT 0");
  }

  // Jellyseerr was renamed to Seerr (github.com/seerr-team/seerr) with the API
  // unchanged, so the provider works against either. The stored keys follow the
  // new name; carry a pre-rename install across rather than silently dropping
  // its credentials and reporting the provider as "not configured".
  {
    const renames: [string, string][] = [
      ['jellyseerr.url', 'seerr.url'],
      ['jellyseerr.api_key', 'seerr.api_key'],
    ];
    for (const [from, to] of renames) {
      const old = db.prepare('SELECT value FROM settings WHERE key = ?').get(from) as { value: string } | undefined;
      if (!old?.value) continue;
      const current = db.prepare('SELECT value FROM settings WHERE key = ?').get(to) as { value: string } | undefined;
      if (current?.value) continue;   // already migrated, or deliberately set
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(to, old.value);
      db.prepare('DELETE FROM settings WHERE key = ?').run(from);
      logger.info(`DB migration: ${from} -> ${to}`);
    }
    const provider = db.prepare("SELECT value FROM settings WHERE key = 'watchlist.provider'").get() as { value: string } | undefined;
    if (provider?.value === 'jellyseerr') {
      db.prepare("UPDATE settings SET value = 'seerr' WHERE key = 'watchlist.provider'").run();
    }
  }

  // Seerr addresses shows through the Sonarr contract, whose payload carries
  // ONLY a tvdbId — no tmdb, no imdb. Without somewhere to keep it, the same show
  // could never be recognised again and every repeat request created a duplicate.
  if (!columns.find(c => c.name === 'tvdb_id')) {
    db.exec("ALTER TABLE movies ADD COLUMN tvdb_id INTEGER");
  }

  if (!columns.find(c => c.name === 'watchlist_source')) {
    db.exec("ALTER TABLE movies ADD COLUMN watchlist_source TEXT");
    // Repair the rows the old behaviour produced: a Plex-sourced entry is one
    // whose trakt_id is exactly its tmdb_id (that is what the substitution wrote).
    // Genuine Trakt rows where the two ids coincide are possible but vanishingly
    // rare, and the cost of a wrong guess here is one re-add on the next sync.
    const repaired = db.prepare(`
      UPDATE movies SET watchlist_source = 'plex', trakt_id = NULL
      WHERE trakt_id IS NOT NULL AND tmdb_id IS NOT NULL AND trakt_id = tmdb_id
    `).run();
    if (repaired.changes > 0) {
      logger.info(`DB migration: cleared the TMDb-id-as-trakt_id substitution on ${repaired.changes} Plex watchlist row(s)`);
    }
  }

  // Carry pre-rename rows over to the new provider name. MUST come after the
  // ALTER above: the base CREATE TABLE has no watchlist_source, so on a brand-new
  // database this UPDATE ran against a column that did not exist yet and threw
  // `no such column: watchlist_source` — initDatabase() aborted and the app could
  // not start at all. Only fresh installs were affected (an upgraded database
  // already had the column), which is why it survived release.
  {
    const relabelled = db.prepare("UPDATE movies SET watchlist_source = 'seerr' WHERE watchlist_source = 'jellyseerr'").run();
    if (relabelled.changes > 0) {
      logger.info(`DB migration: relabelled ${relabelled.changes} row(s) from jellyseerr to seerr`);
    }
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
    -- isReleaseBlocklisted() compares LOWER(release_name), which a plain column
    -- index cannot serve — every lookup was a full table scan, run once per
    -- release in three hot loops (titles × plugins × releases per pass) against
    -- an append-only table. An expression index matches the query as written.
    CREATE INDEX IF NOT EXISTS idx_blocklist_release_name_lower ON blocklist(LOWER(release_name));
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
}
