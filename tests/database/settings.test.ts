import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { applySchema } from '../../src/database/schema';
import {
  createSettingsStore, migrateLegacyCaptchaKey, migrateSettingsToEncrypted,
} from '../../src/database/settings';
import { encrypt, isEncrypted, registerSensitiveKey, getUndecryptableKeys } from '../../src/database/encryption';
import { logger } from '../../src/utils/logger';

/**
 * `set()` decides in one expression whether a credential reaches the disk as
 * ciphertext or in the clear. It ran on every boot of every install and was not
 * covered by a single test — the settings layer sat in `database/index.ts`, which
 * opens the real database file at import time and is therefore mocked away
 * everywhere. Real encryption is used here on purpose: mocking it would test the
 * mock, and the question is precisely what lands in the settings table.
 */
function fresh(): DatabaseType {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

/** The value as it actually sits on disk, bypassing the store. */
function raw(db: DatabaseType, key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

/**
 * Ciphertext that decrypts to nothing: same shape and length, damaged auth tag —
 * what bit rot or a key that no longer matches the database looks like.
 */
function corrupt(ciphertext: string): string {
  return ciphertext.slice(0, -6) + (ciphertext.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA');
}

function write(db: DatabaseType, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

describe('settings store — encryption at rest', () => {
  let db: DatabaseType;
  let settings: ReturnType<typeof createSettingsStore>;

  beforeEach(() => {
    db = fresh();
    settings = createSettingsStore(db);
  });

  it('stores a sensitive value as ciphertext and reads it back as plaintext', () => {
    settings.set('jdownloader.password', 'hunter2');

    const stored = raw(db, 'jdownloader.password')!;
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain('hunter2');
    expect(settings.get('jdownloader.password')).toBe('hunter2');

    // What the NEXT boot sees: a store that never held this value in cache.
    expect(createSettingsStore(db).get('jdownloader.password')).toBe('hunter2');
  });

  it('stores a non-sensitive value verbatim', () => {
    settings.set('quality.minimum', '1080p');

    expect(raw(db, 'quality.minimum')).toBe('1080p');
    expect(settings.get('quality.minimum')).toBe('1080p');
  });

  it('treats every secret-store.* key as sensitive', () => {
    // Plugin-requested shared secrets are matched by prefix, not enumerated.
    settings.set('secret-store.2captcha-api-key', 'abc123');

    expect(isEncrypted(raw(db, 'secret-store.2captcha-api-key')!)).toBe(true);
    expect(settings.get('secret-store.2captcha-api-key')).toBe('abc123');
  });

  it('encrypts a key that a plugin manifest registered at runtime', () => {
    registerSensitiveKey('plugin.example.token');
    settings.set('plugin.example.token', 'plugin-secret');

    expect(isEncrypted(raw(db, 'plugin.example.token')!)).toBe(true);
    expect(settings.get('plugin.example.token')).toBe('plugin-secret');
  });

  it('leaves a cleared secret as an empty string, not as ciphertext', () => {
    settings.set('trakt.access_token', 'token-abc');
    settings.set('trakt.access_token', '');

    // "Not configured" has to stay recognisably empty — the health check and the
    // setup wizard both read emptiness as "the user has not entered this yet".
    expect(raw(db, 'trakt.access_token')).toBe('');
    expect(settings.get('trakt.access_token')).toBe('');
  });

  it('writes a fresh ciphertext on every overwrite', () => {
    settings.set('telegram.bot_token', 'same-token');
    const first = raw(db, 'telegram.bot_token')!;
    settings.set('telegram.bot_token', 'same-token');
    const second = raw(db, 'telegram.bot_token')!;

    expect(second).not.toBe(first); // random IV per write
    expect(settings.get('telegram.bot_token')).toBe('same-token');
  });

  it('never hands the ciphertext to a caller, cache warm or cold', () => {
    settings.get('quality.minimum');        // warm the cache first
    settings.set('seerr.api_key', 'seerr-key');

    // Caching the stored value instead of the plaintext would ship `enc:…` to
    // every consumer of getSetting() — Trakt, JD, Telegram would all authenticate
    // with the ciphertext.
    expect(settings.get('seerr.api_key')).toBe('seerr-key');
    expect(settings.getAll()['seerr.api_key']).toBe('seerr-key');
  });
});

describe('settings store — cache', () => {
  let db: DatabaseType;
  let settings: ReturnType<typeof createSettingsStore>;

  beforeEach(() => {
    db = fresh();
    settings = createSettingsStore(db);
  });

  it('serves reads from the cache until it is invalidated', () => {
    write(db, 'scheduler.interval_hours', '24');
    expect(settings.get('scheduler.interval_hours')).toBe('24');

    write(db, 'scheduler.interval_hours', '6'); // behind the store's back
    expect(settings.get('scheduler.interval_hours')).toBe('24');

    settings.invalidate();
    expect(settings.get('scheduler.interval_hours')).toBe('6');
  });

  it('returns a copy from getAll, so callers cannot mutate the cache', () => {
    write(db, 'quality.preferred', '2160p');

    const all = settings.getAll();
    all['quality.preferred'] = 'tampered';

    expect(settings.get('quality.preferred')).toBe('2160p');
  });

  it('returns an empty string for an unknown key', () => {
    expect(settings.get('does.not.exist')).toBe('');
  });
});

describe('settings store — undecryptable secrets', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = fresh();
    vi.clearAllMocks();
  });

  it('degrades a corrupted secret to empty, records it, and still loads the rest', () => {
    write(db, 'jellyfin.api_key', corrupt(encrypt('lost-to-bit-rot')));
    write(db, 'jellyfin.url', 'http://jellyfin:8096');
    write(db, 'telegram.bot_token', encrypt('good-token'));

    const settings = createSettingsStore(db);

    // A throw here would brick the app: getSetting() is called from everywhere.
    expect(settings.get('jellyfin.api_key')).toBe('');
    expect(settings.get('jellyfin.url')).toBe('http://jellyfin:8096');
    expect(settings.get('telegram.bot_token')).toBe('good-token');

    // Recorded, not swallowed — otherwise a lost key file is indistinguishable
    // from a fresh install and the user re-enters everything without ever
    // learning why.
    expect(getUndecryptableKeys()).toContain('jellyfin.api_key');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('jellyfin.api_key'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not be decrypted'));
  });

  it('clears the failure list when a later load succeeds', () => {
    write(db, 'plex.token', corrupt(encrypt('unreadable')));
    createSettingsStore(db).get('plex.token');
    expect(getUndecryptableKeys()).toContain('plex.token');

    write(db, 'plex.token', encrypt('repaired'));
    const settings = createSettingsStore(db);

    expect(settings.get('plex.token')).toBe('repaired');
    expect(getUndecryptableKeys()).not.toContain('plex.token');
  });
});

describe('migrateSettingsToEncrypted', () => {
  let db: DatabaseType;

  beforeEach(() => { db = fresh(); });

  it('encrypts plaintext secrets left in the table', () => {
    write(db, 'trakt.client_secret', 'plain-secret');

    migrateSettingsToEncrypted(db);

    expect(isEncrypted(raw(db, 'trakt.client_secret')!)).toBe(true);
    expect(createSettingsStore(db).get('trakt.client_secret')).toBe('plain-secret');
  });

  it('leaves non-sensitive rows alone', () => {
    write(db, 'paths.movies', '/movies');

    migrateSettingsToEncrypted(db);

    expect(raw(db, 'paths.movies')).toBe('/movies');
  });

  it('skips empty secrets', () => {
    write(db, 'omdb.api_key', '');

    migrateSettingsToEncrypted(db);

    expect(raw(db, 'omdb.api_key')).toBe('');
  });

  it('does not double-encrypt on the next boot', () => {
    write(db, 'arr.api_key', 'arr-secret');

    migrateSettingsToEncrypted(db);
    const afterFirst = raw(db, 'arr.api_key')!;
    migrateSettingsToEncrypted(db);

    expect(raw(db, 'arr.api_key')).toBe(afterFirst);
    expect(createSettingsStore(db).get('arr.api_key')).toBe('arr-secret');
  });
});

describe('migrateLegacyCaptchaKey', () => {
  let db: DatabaseType;

  beforeEach(() => { db = fresh(); });

  it('moves the legacy key under secret-store.* without decrypting it', () => {
    const ciphertext = encrypt('2captcha-key');
    write(db, 'captcha.twocaptcha_key', ciphertext);

    migrateLegacyCaptchaKey(db);

    expect(raw(db, 'secret-store.2captcha-api-key')).toBe(ciphertext);
    expect(raw(db, 'captcha.twocaptcha_key')).toBeUndefined();
    expect(createSettingsStore(db).get('secret-store.2captcha-api-key')).toBe('2captcha-key');
  });

  it('drops the legacy row without overwriting an already populated new key', () => {
    const current = encrypt('current-key');
    write(db, 'secret-store.2captcha-api-key', current);
    write(db, 'captcha.twocaptcha_key', encrypt('stale-key'));

    migrateLegacyCaptchaKey(db);

    expect(raw(db, 'secret-store.2captcha-api-key')).toBe(current);
    expect(raw(db, 'captcha.twocaptcha_key')).toBeUndefined();
  });

  it('drops an empty legacy row without creating the new key', () => {
    write(db, 'captcha.twocaptcha_key', '');

    migrateLegacyCaptchaKey(db);

    expect(raw(db, 'captcha.twocaptcha_key')).toBeUndefined();
    expect(raw(db, 'secret-store.2captcha-api-key')).toBeUndefined();
  });

  it('does nothing when there is no legacy row', () => {
    migrateLegacyCaptchaKey(db);

    expect(raw(db, 'secret-store.2captcha-api-key')).toBeUndefined();
  });
});
