import type { Database as DatabaseType } from 'better-sqlite3';
import {
  isSensitiveKey, isEncrypted, encrypt, decrypt,
  clearDecryptFailures, recordDecryptFailure, getUndecryptableKeys,
} from './encryption';
import { logger } from '../utils/logger';

/**
 * The settings table: the cached read/write layer plus the two migrations that
 * rewrite rows in place.
 *
 * This lives apart from `index.ts` for the same reason `schema.ts` does — that
 * module opens the real database file at import time, so the test suite mocks it
 * wholesale. Which meant the single line that decides whether the Trakt token and
 * the JDownloader password reach the disk as ciphertext or as plaintext was never
 * executed by a test. Taking a `db` parameter lets the tests drive this against an
 * in-memory database built from the production schema.
 *
 * Deliberately left behind in `initDatabase()`: the settings defaults, the
 * encryption-key init and the activity-log prune. Those are boot sequencing, and
 * their order relative to each other is the thing that matters there.
 */

export interface SettingsStore {
  get(key: string): string;
  set(key: string, value: string): void;
  getAll(): Record<string, string>;
  /** Drop the cache so the next read comes from disk. */
  invalidate(): void;
}

export function createSettingsStore(db: DatabaseType): SettingsStore {
  // In-memory settings cache — every read goes through here.
  let cache: Record<string, string> | null = null;

  function load(): Record<string, string> {
    if (!cache) {
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      cache = {};
      clearDecryptFailures();
      for (const row of rows) {
        if (!isSensitiveKey(row.key)) {
          cache[row.key] = row.value;
          continue;
        }
        try {
          cache[row.key] = decrypt(row.value);
        } catch (err: any) {
          // A single undecryptable secret (corrupted ciphertext, or a lost/rotated
          // encryption key — plausible after a volume misconfig) must NOT throw out
          // of here: getSetting()/getAllSettings() are called everywhere, so a throw
          // would brick the whole app. Degrade just that key to empty and continue —
          // but RECORD it, so the health check can say so. Silently reporting every
          // credential as "not configured" is indistinguishable from a fresh
          // install, and users re-entered everything without ever learning why.
          logger.warn(`Failed to decrypt setting "${row.key}" — treating as empty (${err?.message || err})`);
          recordDecryptFailure(row.key);
          cache[row.key] = '';
        }
      }
      const failed = getUndecryptableKeys();
      if (failed.length > 0) {
        logger.error(
          `${failed.length} stored secret(s) could not be decrypted (${failed.join(', ')}). ` +
          'The encryption key in the data volume does not match the database — restore the .key file, ' +
          'or re-enter these credentials in Settings. They currently read as "not configured".',
        );
      }
    }
    return cache;
  }

  return {
    get(key: string): string {
      return load()[key] ?? '';
    },

    set(key: string, value: string): void {
      const storedValue = isSensitiveKey(key) && value ? encrypt(value) : value;
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, storedValue);
      // Surgically update the cache for this key — invalidating the whole cache
      // forced a fresh disk read of every setting on the next get(), which adds
      // up during a sync that touches dozens of settings per movie. Note this
      // caches the PLAINTEXT: callers must never see the `enc:` form.
      if (cache) {
        cache[key] = value;
      }
    },

    getAll(): Record<string, string> {
      return { ...load() };
    },

    invalidate(): void {
      cache = null;
    },
  };
}

/**
 * One-time migration: existing `captcha.twocaptcha_key` rows pre-date the generic
 * plugin-secrets system and need to move under `secret-store.*` so the captcha
 * concept is removed from the core's vocabulary. The value moves across still
 * encrypted — it is never decrypted here.
 */
export function migrateLegacyCaptchaKey(db: DatabaseType): void {
  const legacyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('captcha.twocaptcha_key') as { value: string } | undefined;
  if (!legacyRow) return;
  const newRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('secret-store.2captcha-api-key') as { value: string } | undefined;
  if (newRow && newRow.value) {
    // New key already populated — just drop the legacy row.
    db.prepare('DELETE FROM settings WHERE key = ?').run('captcha.twocaptcha_key');
    return;
  }
  if (legacyRow.value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('secret-store.2captcha-api-key', legacyRow.value);
  }
  db.prepare('DELETE FROM settings WHERE key = ?').run('captcha.twocaptcha_key');
}

/** Migrate plaintext sensitive values to encrypted. Idempotent. */
export function migrateSettingsToEncrypted(db: DatabaseType): void {
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
