import fs from 'fs';
import path from 'path';
import { readTarGz } from './backupArchive';

/**
 * Restore is a TWO-PHASE operation, and it has to be.
 *
 * The database file is opened by better-sqlite3 the moment `database/index.ts`
 * is imported, and it stays open for the process lifetime. Overwriting it under
 * a live handle is how you get a half-restored database: the old connection
 * still holds page cache and a WAL that no longer matches the file.
 *
 * So the API route only STAGES a restore — it unpacks the archive into
 * `data/restore-pending/` and asks the process to exit. On the next boot,
 * `applyPendingRestore()` runs BEFORE the database is opened, moves the staged
 * files into place, and clears the staging directory. Crash-safe by
 * construction: if anything dies mid-way the staging directory survives and the
 * next boot simply tries again.
 *
 * This module deliberately imports NOTHING from the database or the logger — it
 * has to be usable before either exists.
 */

const DATA_DIR = path.join(__dirname, '../../data');
const PENDING_DIR = path.join(DATA_DIR, 'restore-pending');
const DB_FILE = path.join(DATA_DIR, 'dlvault.db');
const KEY_FILE = path.join(DATA_DIR, '.key');
const PLUGINS_DIR = path.join(DATA_DIR, 'plugins');

/** Entry names inside an archive, mirrored as filenames in the staging dir. */
const STAGED_DB = 'dlvault.db';
const STAGED_KEY = 'key';
const STAGED_PLUGINS = 'plugins';
const STAGED_MANIFEST = 'manifest.json';

export interface ArchiveManifest {
  archiveVersion: number;
  createdAt: string;
  appVersion?: string;
  includesKey: boolean;
  pluginCount: number;
}

export interface StageResult {
  manifest: ArchiveManifest;
  restoredKey: boolean;
  pluginCount: number;
}

export function hasPendingRestore(): boolean {
  return fs.existsSync(path.join(PENDING_DIR, STAGED_DB));
}

/**
 * Unpack an archive into the staging directory. Validates before writing
 * anything, so a malformed file is rejected rather than half-applied.
 */
export function stageRestore(archive: Buffer): StageResult {
  let entries;
  try {
    entries = readTarGz(archive);
  } catch (err: any) {
    throw new Error(`Archiv konnte nicht gelesen werden: ${err?.message || err}`);
  }

  const byName = new Map(entries.map(e => [e.name, e.content]));

  const manifestRaw = byName.get(STAGED_MANIFEST);
  if (!manifestRaw) {
    throw new Error('Kein manifest.json im Archiv — das ist kein dlvault-Backup.');
  }
  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse(manifestRaw.toString('utf-8'));
  } catch {
    throw new Error('manifest.json im Archiv ist beschädigt.');
  }
  if (manifest.archiveVersion > 1) {
    throw new Error(
      `Archiv-Version ${manifest.archiveVersion} ist neuer als diese dlvault-Version versteht — bitte zuerst aktualisieren.`,
    );
  }

  const dbContent = byName.get(STAGED_DB);
  if (!dbContent || dbContent.length === 0) {
    throw new Error('Keine Datenbank im Archiv.');
  }
  // A SQLite file always starts with this magic string. Catches a truncated
  // download or the wrong file entirely before we stage it for boot.
  if (dbContent.subarray(0, 15).toString('ascii') !== 'SQLite format 3') {
    throw new Error('Die enthaltene Datei ist keine gültige SQLite-Datenbank.');
  }

  // Write the staging dir fresh so a previous aborted attempt can't bleed in.
  fs.rmSync(PENDING_DIR, { recursive: true, force: true });
  fs.mkdirSync(PENDING_DIR, { recursive: true });

  fs.writeFileSync(path.join(PENDING_DIR, STAGED_DB), dbContent);
  fs.writeFileSync(path.join(PENDING_DIR, STAGED_MANIFEST), manifestRaw);

  const keyContent = byName.get(STAGED_KEY);
  if (keyContent && keyContent.length > 0) {
    fs.writeFileSync(path.join(PENDING_DIR, STAGED_KEY), keyContent, { mode: 0o600 });
  }

  let pluginCount = 0;
  const stagedPluginsDir = path.join(PENDING_DIR, STAGED_PLUGINS);
  for (const [name, content] of byName) {
    if (!name.startsWith(`${STAGED_PLUGINS}/`)) continue;
    const base = path.basename(name);
    // Defence in depth: an archive is untrusted input, and a crafted entry name
    // must not escape the staging directory.
    if (base !== name.slice(STAGED_PLUGINS.length + 1)) continue;
    if (!fs.existsSync(stagedPluginsDir)) fs.mkdirSync(stagedPluginsDir, { recursive: true });
    fs.writeFileSync(path.join(stagedPluginsDir, base), content);
    pluginCount++;
  }

  return { manifest, restoredKey: !!keyContent, pluginCount };
}

/** Discard a staged restore (used when the user changes their mind). */
export function cancelPendingRestore(): void {
  fs.rmSync(PENDING_DIR, { recursive: true, force: true });
}

/**
 * Apply a staged restore. MUST be called before the database is opened.
 *
 * Returns a human-readable summary of what happened, or null when there was
 * nothing to do. Never throws: a failure here would otherwise make the app
 * unbootable, and the safest outcome is to leave the current data alone and
 * carry on with a loud message.
 */
export function applyPendingRestore(): string | null {
  if (!hasPendingRestore()) return null;

  const notes: string[] = [];
  try {
    // Keep the current database next to the new one. A restore is destructive
    // and "I picked the wrong backup" needs a way back that doesn't depend on
    // the user having made another backup first.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (fs.existsSync(DB_FILE)) {
      fs.copyFileSync(DB_FILE, `${DB_FILE}.pre-restore-${stamp}`);
      notes.push(`previous database kept as dlvault.db.pre-restore-${stamp}`);
    }

    fs.copyFileSync(path.join(PENDING_DIR, STAGED_DB), DB_FILE);
    // The WAL/SHM sidecars belong to the OLD database. Leaving them would let
    // SQLite replay stale pages over the file we just restored.
    for (const sidecar of [`${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
      fs.rmSync(sidecar, { force: true });
    }
    notes.push('database restored');

    const stagedKey = path.join(PENDING_DIR, STAGED_KEY);
    if (fs.existsSync(stagedKey)) {
      if (fs.existsSync(KEY_FILE)) fs.copyFileSync(KEY_FILE, `${KEY_FILE}.pre-restore-${stamp}`);
      fs.copyFileSync(stagedKey, KEY_FILE);
      fs.chmodSync(KEY_FILE, 0o600);
      notes.push('encryption key restored');
    } else {
      notes.push('archive contained no encryption key — stored credentials stay unreadable unless the current key matches');
    }

    const stagedPlugins = path.join(PENDING_DIR, STAGED_PLUGINS);
    if (fs.existsSync(stagedPlugins)) {
      if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
      let count = 0;
      for (const name of fs.readdirSync(stagedPlugins)) {
        fs.copyFileSync(path.join(stagedPlugins, name), path.join(PLUGINS_DIR, name));
        count++;
      }
      notes.push(`${count} plugin file(s) restored`);
    }

    fs.rmSync(PENDING_DIR, { recursive: true, force: true });
    return notes.join('; ');
  } catch (err: any) {
    // Leave the staging dir in place so the next boot retries, and say so.
    return `RESTORE FAILED: ${err?.message || err} — staged files kept at ${PENDING_DIR}, will retry on next start`;
  }
}
