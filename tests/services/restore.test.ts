import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildTarGz } from '../../src/services/backupArchive';

/**
 * restore.ts resolves its paths from its own __dirname, so like the encryption
 * guard tests we redirect the `data` directory through fs spies and load a fresh
 * module instance per case.
 */
let dataDir: string;

const realExists = fs.existsSync;
const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
const realMkdir = fs.mkdirSync;
const realReaddir = fs.readdirSync;
const realCopy = fs.copyFileSync;
const realRm = fs.rmSync;
const realChmod = fs.chmodSync;

const DATA_SUFFIX = `${path.sep}data`;

async function loadModule() {
  vi.restoreAllMocks();
  vi.resetModules();
  const redirect = (p: any) => {
    const s = String(p);
    const idx = s.indexOf(DATA_SUFFIX);
    // Rewrite "<anything>/data[/...]" onto the temp dir, leaving other paths be.
    if (idx !== -1) return path.join(dataDir, s.slice(idx + DATA_SUFFIX.length));
    return s;
  };
  vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => realExists(redirect(p)));
  vi.spyOn(fs, 'readFileSync').mockImplementation((p: any, o: any) => realRead(redirect(p), o));
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p: any, d: any, o: any) => realWrite(redirect(p), d, o));
  vi.spyOn(fs, 'mkdirSync').mockImplementation((p: any, o: any) => realMkdir(redirect(p), o));
  vi.spyOn(fs, 'readdirSync').mockImplementation((p: any, o: any) => realReaddir(redirect(p), o));
  vi.spyOn(fs, 'copyFileSync').mockImplementation((a: any, b: any) => realCopy(redirect(a), redirect(b)));
  vi.spyOn(fs, 'rmSync').mockImplementation((p: any, o: any) => realRm(redirect(p), o));
  vi.spyOn(fs, 'chmodSync').mockImplementation((p: any, m: any) => realChmod(redirect(p), m));
  return import('../../src/services/restore');
}

/** A valid SQLite file starts with this magic — the restore path checks for it. */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');
function fakeDb(marker: string): Buffer {
  return Buffer.concat([SQLITE_MAGIC, Buffer.from(marker)]);
}

function goodArchive(opts: { key?: boolean; plugins?: string[]; marker?: string } = {}): Buffer {
  const entries = [
    { name: 'dlvault.db', content: fakeDb(opts.marker ?? 'RESTORED') },
    {
      name: 'manifest.json',
      content: Buffer.from(JSON.stringify({
        archiveVersion: 1, createdAt: new Date(0).toISOString(),
        includesKey: !!opts.key, pluginCount: (opts.plugins || []).length,
      })),
    },
  ];
  if (opts.key) entries.push({ name: 'key', content: Buffer.from('abc123') });
  for (const p of opts.plugins || []) {
    entries.push({ name: `plugins/${p}`, content: Buffer.from(`// ${p}`) });
  }
  return buildTarGz(entries);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-restore-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('stageRestore', () => {
  it('unpacks a valid archive into the staging area without touching live files', async () => {
    const mod = await loadModule();
    realWrite(path.join(dataDir, 'dlvault.db'), fakeDb('ORIGINAL'));

    const result = mod.stageRestore(goodArchive({ key: true, plugins: ['demo.dlvault.js'] }));

    expect(result.restoredKey).toBe(true);
    expect(result.pluginCount).toBe(1);
    expect(mod.hasPendingRestore()).toBe(true);
    // The live database must be untouched until the next boot applies it.
    expect(realRead(path.join(dataDir, 'dlvault.db')).toString()).toContain('ORIGINAL');
  });

  it('rejects an archive without a manifest', async () => {
    const mod = await loadModule();
    const archive = buildTarGz([{ name: 'dlvault.db', content: fakeDb('X') }]);
    expect(() => mod.stageRestore(archive)).toThrow(/manifest/i);
    expect(mod.hasPendingRestore()).toBe(false);
  });

  it('rejects a payload that is not a SQLite database', async () => {
    const mod = await loadModule();
    const archive = buildTarGz([
      { name: 'dlvault.db', content: Buffer.from('<html>rate limited</html>') },
      { name: 'manifest.json', content: Buffer.from('{"archiveVersion":1}') },
    ]);
    expect(() => mod.stageRestore(archive)).toThrow(/SQLite/i);
    expect(mod.hasPendingRestore()).toBe(false);
  });

  it('refuses an archive from a newer format version', async () => {
    const mod = await loadModule();
    const archive = buildTarGz([
      { name: 'dlvault.db', content: fakeDb('X') },
      { name: 'manifest.json', content: Buffer.from('{"archiveVersion":99}') },
    ]);
    expect(() => mod.stageRestore(archive)).toThrow(/neuer/i);
  });

  it('rejects a corrupt archive', async () => {
    const mod = await loadModule();
    expect(() => mod.stageRestore(Buffer.from('not a gzip at all'))).toThrow(/gelesen/i);
  });
});

describe('applyPendingRestore', () => {
  it('does nothing when no restore is staged', async () => {
    const mod = await loadModule();
    expect(mod.applyPendingRestore()).toBeNull();
  });

  it('swaps in the database, key and plugins, and keeps the old database', async () => {
    const mod = await loadModule();
    realWrite(path.join(dataDir, 'dlvault.db'), fakeDb('ORIGINAL'));
    realWrite(path.join(dataDir, '.key'), 'oldkey');
    // Stale WAL/SHM belong to the OLD database — they must not survive.
    realWrite(path.join(dataDir, 'dlvault.db-wal'), 'stale');
    realWrite(path.join(dataDir, 'dlvault.db-shm'), 'stale');

    mod.stageRestore(goodArchive({ key: true, plugins: ['demo.dlvault.js'], marker: 'NEW' }));
    const summary = mod.applyPendingRestore();

    expect(summary).toContain('database restored');
    expect(summary).toContain('encryption key restored');
    expect(realRead(path.join(dataDir, 'dlvault.db')).toString()).toContain('NEW');
    expect(realRead(path.join(dataDir, '.key'), 'utf-8')).toBe('abc123');
    expect(realRead(path.join(dataDir, 'plugins', 'demo.dlvault.js'), 'utf-8')).toBe('// demo.dlvault.js');
    expect(realExists(path.join(dataDir, 'dlvault.db-wal'))).toBe(false);
    expect(realExists(path.join(dataDir, 'dlvault.db-shm'))).toBe(false);

    // A safety copy of the replaced database exists — "wrong backup" needs a way back.
    const preserved = realReaddir(dataDir).filter(f => f.includes('pre-restore'));
    expect(preserved.length).toBeGreaterThan(0);

    // Staging is cleared, so the next boot doesn't restore again.
    expect(mod.hasPendingRestore()).toBe(false);
  });

  it('says so when the archive carried no key', async () => {
    const mod = await loadModule();
    realWrite(path.join(dataDir, 'dlvault.db'), fakeDb('ORIGINAL'));

    mod.stageRestore(goodArchive({ key: false }));
    const summary = mod.applyPendingRestore();

    expect(summary).toContain('no encryption key');
  });

  it('can be cancelled before it is applied', async () => {
    const mod = await loadModule();
    mod.stageRestore(goodArchive());
    expect(mod.hasPendingRestore()).toBe(true);

    mod.cancelPendingRestore();

    expect(mod.hasPendingRestore()).toBe(false);
    expect(mod.applyPendingRestore()).toBeNull();
  });
});
