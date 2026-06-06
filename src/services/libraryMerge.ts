import fs from 'fs';
import path from 'path';

/**
 * A show folder under an older name scheme next to the current one, which the
 * template rename (normalizeLibraryName) cannot just rename. Pure file
 * operations, no database, so the rules are testable on a temp directory.
 */

const MEDIA_RE = /\.(mkv|mp4|avi|m4v|wmv|ts)$/i;
/** Written by the media server per file; rebuilt for the moved copy. */
const SERVER_DIR_RE = /\.trickplay$/i;
/** Unfinished copies: never worth keeping, never worth moving. */
const PARTIAL_RE = /\.(incomplete|part|partial|tmp)$/i;
const JUNK_RE = /\.(url|txt|nfo|jpg|jpeg|png|sfv|md5|exe|html?)$/i;

function episodeKey(file: string): string | null {
  const m = /S(\d{1,2})E(\d{1,3})/i.exec(file);
  return m ? `${Number(m[1])}x${Number(m[2])}` : null;
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (!SERVER_DIR_RE.test(e.name)) out.push(...walk(dir, r));
    } else {
      out.push(r);
    }
  }
  return out;
}

export interface MergeResult {
  /** The old folder is gone: everything in it is in the current one now. */
  removed: boolean;
  moved: string[];
  /** Episodes the current folder already has; the old copy was dropped. */
  dropped: string[];
  /** Left in place because the current folder has a different file there. */
  kept: string[];
}

/**
 * Fold a show folder under an older name into the current one. An episode the
 * current folder lacks moves over; one it already has (any file with the same
 * SxxEyy) is the current copy, so the old one goes. Anything else moves over
 * unless a different file of that name is already there — then the old folder
 * stays, with that file, for a person to look at. Unfinished copies and the
 * server's trickplay folders are dropped.
 */
export function mergeShowFolder(oldDir: string, newDir: string): MergeResult {
  const res: MergeResult = { removed: false, moved: [], dropped: [], kept: [] };
  const have = new Set(walk(newDir).filter(f => MEDIA_RE.test(f)).map(f => episodeKey(path.basename(f))).filter(Boolean));
  for (const rel of walk(oldDir)) {
    const from = path.join(oldDir, rel);
    if (PARTIAL_RE.test(rel)) continue;
    const key = MEDIA_RE.test(rel) ? episodeKey(path.basename(rel)) : null;
    if (key && have.has(key)) { res.dropped.push(rel); continue; }
    const to = path.join(newDir, rel);
    if (fs.existsSync(to)) {
      // Same file, or server metadata (nfo, artwork) that the server rewrites anyway.
      if (JUNK_RE.test(rel) || fs.statSync(to).size === fs.statSync(from).size) { res.dropped.push(rel); continue; }
      res.kept.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    res.moved.push(rel);
    if (key) have.add(key);
  }
  if (res.kept.length === 0) {
    fs.rmSync(oldDir, { recursive: true, force: true });
    res.removed = true;
  }
  return res;
}
