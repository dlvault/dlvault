import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

vi.mock('../../src/database/index', () => ({ default: {}, getSetting: () => '' }));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { verifyBackupArchive } from '../../src/services/backup';
import { buildTarGz } from '../../src/services/backupArchive';

describe('verifyBackupArchive', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-bk-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function archive(entries: { name: string; content: Buffer }[]): string {
    const f = path.join(dir, 'dlvault-test.tar.gz');
    fs.writeFileSync(f, buildTarGz(entries));
    return f;
  }
  function realDb(): Buffer {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE movies (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO movies (title) VALUES (\'Grell\'), (\'Sandmere\');');
    const buf = db.serialize();
    db.close();
    return buf;
  }

  it('accepts an archive that a restore could actually use', () => {
    const f = archive([
      { name: 'dlvault.db', content: realDb() },
      { name: 'manifest.json', content: Buffer.from('{"archiveVersion":1}') },
    ]);
    expect(verifyBackupArchive(f)).toEqual({ ok: true, detail: '2 Titel, Integrität ok' });
  });

  it('accepts a database that was in WAL mode, like the live one', () => {
    const file = path.join(dir, 'wal.db');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE movies (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO movies (title) VALUES (\'Wardline\');');
    db.close();
    const img = fs.readFileSync(file);
    expect(img[18]).toBe(2);
    const f = archive([
      { name: 'dlvault.db', content: img },
      { name: 'manifest.json', content: Buffer.from('{}') },
    ]);
    expect(verifyBackupArchive(f)).toEqual({ ok: true, detail: '1 Titel, Integrität ok' });
  });

  it('rejects a database that still reads fine but fails SQLite\'s integrity check', () => {
    // A damaged index on a side table: the movies count still works, only
    // integrity_check notices — exactly what a restore would trip over later.
    // The index is pointed at another index's b-tree, so its entries no longer
    // match the table rows.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE movies (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO movies (title) VALUES ('Grell');
             CREATE TABLE t (x TEXT); CREATE INDEX idx_t ON t(x);
             CREATE TABLE u (x TEXT); CREATE INDEX idx_u ON u(x);`);
    for (let i = 0; i < 50; i++) {
      db.prepare('INSERT INTO t (x) VALUES (?)').run(`t-${i}`);
      db.prepare('INSERT INTO u (x) VALUES (?)').run(`u-${i}`);
    }
    const rootU = (db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'idx_u'").get() as { rootpage: number }).rootpage;
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare("UPDATE sqlite_master SET rootpage = ? WHERE name = 'idx_t'").run(rootU);
    db.pragma('writable_schema = OFF');
    const img = Buffer.from(db.serialize());
    db.close();
    const check = new Database(img);
    const readable = (check.prepare('SELECT COUNT(*) AS n FROM movies').get() as { n: number }).n;
    const integrity = check.pragma('integrity_check', { simple: true });
    check.close();
    expect(readable).toBe(1);                 // precondition: plain reads still succeed
    expect(integrity).not.toBe('ok');         // precondition: the damage is real
    const v = verifyBackupArchive(archive([{ name: 'dlvault.db', content: img }, { name: 'manifest.json', content: Buffer.from('{}') }]));
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('Integrität');
  });

  it('rejects an archive without a manifest or without a database', () => {
    expect(verifyBackupArchive(archive([{ name: 'dlvault.db', content: realDb() }])).ok).toBe(false);
    expect(verifyBackupArchive(archive([{ name: 'manifest.json', content: Buffer.from('{}') }])).ok).toBe(false);
  });

  it('rejects a damaged database and an unreadable file', () => {
    const broken = realDb();
    broken.fill(0xff, 4096, 4112);  // trash the b-tree header of the movies table page
    const v = verifyBackupArchive(archive([
      { name: 'dlvault.db', content: broken },
      { name: 'manifest.json', content: Buffer.from('{}') },
    ]));
    expect(v.ok).toBe(false);
    const garbage = path.join(dir, 'x.tar.gz');
    fs.writeFileSync(garbage, 'not an archive');
    expect(verifyBackupArchive(garbage).ok).toBe(false);
  });
});
