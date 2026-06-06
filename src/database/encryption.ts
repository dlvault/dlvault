import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(__dirname, '../../data');
const KEY_FILE = path.join(DATA_DIR, '.key');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENC_PREFIX = 'enc:';

export const SENSITIVE_KEYS = new Set([
  'trakt.client_secret',
  'trakt.access_token',
  'trakt.refresh_token',
  'jdownloader.password',
  'plex.token',
  'jellyfin.api_key',
  'seerr.api_key',
  'tmdb.api_key',
  'arr.api_key',
  'seerr.webhook_token',
  'telegram.bot_token',
  'omdb.api_key',
  // Shared plugin secrets (anything under `secret-store.*`) are picked up by
  // the prefix rule in `isSensitiveKey` — no need to enumerate them.
]);

/**
 * Settings under this prefix are *always* treated as sensitive — they store
 * plugin-requested shared secrets. Must match `SECRET_STORE_PREFIX` in
 * `plugins/context.ts`.
 */
export const SECRET_STORE_KEY_PREFIX = 'secret-store.';

/**
 * Register an additional setting key as sensitive — same encryption-at-rest
 * treatment as the built-ins above. Used by the plugin registry to flag
 * fields a plugin's manifest declares as `type: 'secret'`.
 */
export function registerSensitiveKey(key: string): void {
  SENSITIVE_KEYS.add(key);
}

let encryptionKey: Buffer | null = null;

/**
 * Thrown when the key file is gone but the database still holds ciphertext.
 *
 * Minting a fresh key in that situation is the worst possible response: every
 * stored credential becomes permanently undecryptable, and because
 * loadSettingsCache degrades an undecryptable value to '', the app then reports
 * Trakt/JDownloader/Plex as "not configured". The user re-enters everything and
 * never learns that a volume misconfiguration ate their key. Refusing to start
 * is recoverable; silently re-keying is not.
 */
export class MissingEncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingEncryptionKeyError';
  }
}

/**
 * Set by initEncryption() before the key is touched: tells the loader whether
 * the database already contains encrypted values. Undefined means "not checked"
 * (standalone use, e.g. tests), which keeps the old create-on-demand behaviour.
 */
let dbHasCiphertext: boolean | undefined;

function loadOrCreateKey(): Buffer {
  if (encryptionKey) return encryptionKey;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (fs.existsSync(KEY_FILE)) {
    encryptionKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf-8').trim(), 'hex');
    return encryptionKey;
  }

  if (dbHasCiphertext) {
    throw new MissingEncryptionKeyError(
      `The encryption key ${KEY_FILE} is missing, but the database contains encrypted credentials. ` +
      'Generating a new key would make every stored secret permanently unreadable, so startup is stopped instead. ' +
      'Restore the .key file from a backup (it lives next to dlvault.db in the data volume), or — if it is gone for ' +
      'good — delete the encrypted rows and re-enter the credentials: ' +
      `sqlite3 <data>/dlvault.db "DELETE FROM settings WHERE value LIKE '${ENC_PREFIX}%';"`,
    );
  }

  encryptionKey = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, encryptionKey.toString('hex'), { mode: 0o600 });
  return encryptionKey;
}

export function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEYS.has(key)) return true;
  if (key.startsWith(SECRET_STORE_KEY_PREFIX)) return true;
  return false;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext;

  const key = loadOrCreateKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // iv (12) + encrypted (variable) + authTag (16)
  const combined = Buffer.concat([iv, encrypted, authTag]);
  return ENC_PREFIX + combined.toString('base64');
}

export function decrypt(encValue: string): string {
  if (!encValue || !isEncrypted(encValue)) return encValue;

  const key = loadOrCreateKey();
  const combined = Buffer.from(encValue.slice(ENC_PREFIX.length), 'base64');

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf-8');
}

/**
 * Initialise the key.
 *
 * `hasCiphertext` reports whether the settings table already holds `enc:` values.
 * Pass it so a missing key file is treated as "restore it" rather than "make a
 * new one" — see {@link MissingEncryptionKeyError}.
 */
export function initEncryption(hasCiphertext?: boolean): void {
  dbHasCiphertext = hasCiphertext;
  loadOrCreateKey();
}

/**
 * Secrets that could not be decrypted during the last cache load, by setting
 * key. Non-empty means the key on disk does not match the stored ciphertext —
 * the health check surfaces this as an error, because the alternative
 * (everything quietly reporting "not configured") is indistinguishable from a
 * fresh install.
 */
const undecryptableKeys = new Set<string>();

export function recordDecryptFailure(key: string): void {
  undecryptableKeys.add(key);
}

export function clearDecryptFailures(): void {
  undecryptableKeys.clear();
}

export function getUndecryptableKeys(): string[] {
  return [...undecryptableKeys];
}
