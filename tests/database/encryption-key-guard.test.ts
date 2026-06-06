import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The encryption module resolves DATA_DIR from its own __dirname, so the key
 * file it touches is fixed at import time. These tests exercise the guard by
 * loading a fresh module instance per case with a redirected data dir.
 */
let tmpRoot: string;

// Captured ONCE, before any spy is installed. Grabbing them inside loadModule
// would capture the previous call's spy on a second load and recurse forever.
const realExists = fs.existsSync;
const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
const realMkdir = fs.mkdirSync;

async function loadModule(dataDir: string) {
  vi.restoreAllMocks();
  vi.resetModules();
  // encryption.ts derives DATA_DIR as `<module>/../../data`; mocking path.join
  // would be fragile, so spy on fs and redirect just the key file instead.
  const KEY_FILE_SUFFIX = path.join('data', '.key');
  const redirect = (p: any) => {
    const s = String(p);
    if (s.endsWith(KEY_FILE_SUFFIX)) return path.join(dataDir, '.key');
    if (s.endsWith(`${path.sep}data`)) return dataDir;
    return s;
  };
  vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => realExists(redirect(p)));
  vi.spyOn(fs, 'readFileSync').mockImplementation((p: any, o: any) => realRead(redirect(p), o));
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p: any, d: any, o: any) => realWrite(redirect(p), d, o));
  vi.spyOn(fs, 'mkdirSync').mockImplementation((p: any, o: any) => realMkdir(redirect(p), o));

  return import('../../src/database/encryption');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-key-'));
  fs.mkdirSync(path.join(tmpRoot), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('encryption key guard', () => {
  it('creates a key on a fresh install (no ciphertext yet)', async () => {
    const mod = await loadModule(tmpRoot);
    expect(() => mod.initEncryption(false)).not.toThrow();
    expect(fs.existsSync(path.join(tmpRoot, '.key'))).toBe(true);
  });

  it('refuses to mint a new key when the database still holds ciphertext', async () => {
    // The destructive case: a volume misconfig loses .key, a fresh one is
    // generated, and every stored credential becomes permanently unreadable
    // while the app cheerfully reports "not configured".
    const mod = await loadModule(tmpRoot);
    expect(() => mod.initEncryption(true)).toThrow(mod.MissingEncryptionKeyError);
    expect(fs.existsSync(path.join(tmpRoot, '.key'))).toBe(false);
  });

  it('starts normally when the key exists alongside ciphertext', async () => {
    const mod = await loadModule(tmpRoot);
    mod.initEncryption(false);                       // creates the key
    const keyBefore = fs.readFileSync(path.join(tmpRoot, '.key'), 'utf-8');

    const mod2 = await loadModule(tmpRoot);
    expect(() => mod2.initEncryption(true)).not.toThrow();
    expect(fs.readFileSync(path.join(tmpRoot, '.key'), 'utf-8')).toBe(keyBefore);
  });

  it('tracks undecryptable keys for the health check', async () => {
    const mod = await loadModule(tmpRoot);
    expect(mod.getUndecryptableKeys()).toEqual([]);

    mod.recordDecryptFailure('trakt.access_token');
    mod.recordDecryptFailure('plex.token');
    expect(mod.getUndecryptableKeys().sort()).toEqual(['plex.token', 'trakt.access_token']);

    mod.clearDecryptFailures();
    expect(mod.getUndecryptableKeys()).toEqual([]);
  });
});
