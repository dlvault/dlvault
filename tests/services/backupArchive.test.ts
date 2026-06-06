import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildTar, buildTarGz, readTarGz } from '../../src/services/backupArchive';

/**
 * The archive format is hand-rolled, so these tests carry more weight than
 * usual: a backup that cannot be read back is worse than no backup at all.
 */
describe('backup archive', () => {
  it('round-trips a single file', () => {
    const content = Buffer.from('hello backup');
    const entries = readTarGz(buildTarGz([{ name: 'dlvault.db', content }]));

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('dlvault.db');
    expect(entries[0].content.equals(content)).toBe(true);
  });

  it('round-trips several files including nested paths and modes', () => {
    const input = [
      { name: 'dlvault.db', content: Buffer.from('DB') },
      { name: 'key', content: Buffer.from('deadbeef'), mode: 0o600 },
      { name: 'plugins/example-source.dlvault.js', content: Buffer.from('module.exports={}') },
      { name: 'plugins/disclaimer-log.json', content: Buffer.from('{"a":1}') },
      { name: 'manifest.json', content: Buffer.from('{"archiveVersion":1}') },
    ];

    const out = readTarGz(buildTarGz(input));

    expect(out.map(e => e.name)).toEqual(input.map(e => e.name));
    for (let i = 0; i < input.length; i++) {
      expect(out[i].content.equals(input[i].content)).toBe(true);
    }
    expect(out[1].mode).toBe(0o600);
  });

  it('preserves binary content byte-for-byte', () => {
    // A real database is binary and contains NUL bytes and high bytes; a naive
    // string-based writer would corrupt exactly this.
    const binary = Buffer.alloc(5000);
    for (let i = 0; i < binary.length; i++) binary[i] = i % 256;

    const out = readTarGz(buildTarGz([{ name: 'dlvault.db', content: binary }]));

    expect(out[0].content.length).toBe(binary.length);
    expect(out[0].content.equals(binary)).toBe(true);
  });

  it('handles content that lands exactly on a 512-byte boundary', () => {
    // Off-by-one padding bugs hide here: an exact multiple needs NO padding.
    for (const size of [511, 512, 513, 1024]) {
      const content = Buffer.alloc(size, 0x41);
      const out = readTarGz(buildTarGz([{ name: 'f.bin', content }]));
      expect(out).toHaveLength(1);
      expect(out[0].content.length).toBe(size);
      expect(out[0].content.equals(content)).toBe(true);
    }
  });

  it('handles an empty file', () => {
    const out = readTarGz(buildTarGz([{ name: 'empty', content: Buffer.alloc(0) }]));
    expect(out).toHaveLength(1);
    expect(out[0].content.length).toBe(0);
  });

  it('rejects a name too long for the ustar header instead of truncating it', () => {
    expect(() => buildTar([{ name: 'x'.repeat(120), content: Buffer.from('a') }]))
      .toThrow(/too long/i);
  });

  it('ends the tar with two zero blocks', () => {
    const tar = buildTar([{ name: 'a', content: Buffer.from('b') }]);
    const tail = tar.subarray(tar.length - 1024);
    expect(tail.every(b => b === 0)).toBe(true);
  });

  it('produces an archive the system tar can read', () => {
    // The real proof that this is a standard .tar.gz and not merely
    // self-consistent: hand it to an independent implementation.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-tar-'));
    try {
      const archivePath = path.join(tmp, 'backup.tar.gz');
      fs.writeFileSync(archivePath, buildTarGz([
        { name: 'dlvault.db', content: Buffer.from('DBCONTENT') },
        { name: 'plugins/demo.dlvault.js', content: Buffer.from('PLUGIN') },
      ]));

      const outDir = path.join(tmp, 'out');
      fs.mkdirSync(outDir);
      execFileSync('tar', ['-xzf', archivePath, '-C', outDir]);

      expect(fs.readFileSync(path.join(outDir, 'dlvault.db'), 'utf-8')).toBe('DBCONTENT');
      expect(fs.readFileSync(path.join(outDir, 'plugins', 'demo.dlvault.js'), 'utf-8')).toBe('PLUGIN');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
