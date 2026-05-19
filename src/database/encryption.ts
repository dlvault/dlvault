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

function loadOrCreateKey(): Buffer {
  if (encryptionKey) return encryptionKey;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (fs.existsSync(KEY_FILE)) {
    encryptionKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf-8').trim(), 'hex');
  } else {
    encryptionKey = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, encryptionKey.toString('hex'), { mode: 0o600 });
  }

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

export function initEncryption(): void {
  loadOrCreateKey();
}
