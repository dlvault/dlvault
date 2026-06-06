import fs from 'fs';
import path from 'path';
import db, { getSetting } from '../database/index';
import { getAllMovies, type Movie } from '../database/services/movies';
import { getSeasonsByShowIds } from '../database/services/seasons';
import { getDownloadsByMovieIds } from '../database/services/downloads';
import { jdownloaderService, type JDPackage } from '../jdownloader/index';
import { getLibraryProvider, getLibraryProviderName } from './libraryProvider';
import { libraryEpisodesOnDisk } from './integrityCheck';
import { folderMatchesMovie, folderMatchesShow, jdPackageMatchesMovie, normalizeTitle, getLastJdSnapshot } from './postprocess';
import { parseUtcDate } from '../utils/datetime';
import { logger } from '../utils/logger';

/**
 * Consistency watchdog — the four places that each keep their own picture of
 * the library (database, JDownloader, the disk, Jellyfin/Plex) checked against
 * each other once an hour. Almost every serious fault so far was one of these
 * pictures drifting from another at a hand-over; this finds such drift on its
 * own instead of in the next manual audit.
 *
 * It only REPORTS (problem center). Fixing stays with the mechanisms that own
 * each piece — the one exception is asking the media server to rescan when it
 * is missing files that are on disk.
 */

export interface WatchdogFinding {
  key: string;
  severity: 'error' | 'warning' | 'info';
  kind: string;
  movieId: number | null;
  title: string;
  detail: string;
}

const HOUR = 60 * 60 * 1000;
const MEDIA_RE = /\.(mkv|mp4|avi|m4v|ts|m2ts|iso)$/i;
const JUNK_FILE_RE = /\.(url|txt|nfo|jpg|jpeg|png|sfv|md5|exe|html?)$/i;
const JUNK_DIR_RE = /^(sample|proof|subs?|screens?|extras?)$/i;

let findings: WatchdogFinding[] = [];
let lastRunAt = 0;
let lastRescanAt = 0;

export function getWatchdogFindings(): WatchdogFinding[] { return findings; }
export function _resetWatchdog(): void { findings = []; lastRunAt = 0; lastRescanAt = 0; finishedSince.clear(); }

const label = (m: Pick<Movie, 'title' | 'year'>) => (m.year ? `${m.title} (${m.year})` : m.title);
const toServerKey = (k: string) => {
  const [s, e] = k.split('x').map(Number);
  return `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
};

function lastMoveAt(movieId: number): number {
  const r = db.prepare(
    "SELECT MAX(created_at) AS at FROM activity_log WHERE movie_id = ? AND action IN ('moved_to_library', 'repair')",
  ).get(movieId) as { at: string | null } | undefined;
  return r?.at ? parseUtcDate(r.at) : 0;
}

// ── Rule 1: episodes on disk that the media server does not list ──────────
export async function checkShowsAgainstServer(movies: Movie[], now: number): Promise<WatchdogFinding[]> {
  const provider = getLibraryProvider();
  if (!provider.isConfigured()) return [];
  const out: WatchdogFinding[] = [];
  let needsRescan = false;
  for (const m of movies) {
    if (m.media_type !== 'show' || (m.status !== 'downloaded' && m.status !== 'downloading')) continue;
    const disk = libraryEpisodesOnDisk(m);
    if (!disk || disk.size === 0) continue;
    // A fresh move needs a scan first — give the server six hours.
    if (now - lastMoveAt(m.id) < 6 * HOUR) continue;
    const server = await provider.getShowEpisodes(m.imdb_id, m.tmdb_id, m.title, m.year, m.tvdb_id);
    if (!server) continue;                                   // unknown, not "missing"
    const missing = [...disk].map(toServerKey).filter(k => !server.found || !server.episodes.has(k)).sort();
    if (missing.length === 0) continue;
    needsRescan = true;
    out.push({
      key: `wd:server:${m.id}`, severity: 'warning', kind: `${getLibraryProviderName()} fehlen Folgen`,
      movieId: m.id, title: label(m),
      detail: server.found
        ? `${missing.length} Folge(n) liegen auf der Platte, ${getLibraryProviderName()} listet sie nicht: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}`
        : `Die Serie liegt auf der Platte (${disk.size} Folgen), ${getLibraryProviderName()} kennt sie nicht — Ordnername oder Bibliothekspfad prüfen`,
    });
  }
  if (needsRescan && now - lastRescanAt > 6 * HOUR) {
    lastRescanAt = now;
    provider.refreshLibrary().catch(() => { /* best effort */ });
  }
  return out;
}

// ── Rule 2: database states that contradict each other ─────────────────────
export function checkDatabase(movies: Movie[]): WatchdogFinding[] {
  const out: WatchdogFinding[] = [];
  const shows = movies.filter(m => m.media_type === 'show');
  const seasonsBy = getSeasonsByShowIds(shows.map(s => s.id));
  for (const m of shows) {
    const cutoff = m.season_cutoff ?? 1;
    const seasons = (seasonsBy.get(m.id) || []).filter(s => s.season_number >= cutoff);
    for (const s of seasons) {
      if (s.status !== 'downloaded' || !s.aired_episodes) continue;
      const rows = db.prepare(
        "SELECT COUNT(*) AS n, SUM(status = 'downloaded') AS d FROM episodes WHERE season_id = ?",
      ).get(s.id) as { n: number; d: number | null };
      if (rows.n > 0 && (rows.d ?? 0) < s.aired_episodes) {
        out.push({
          key: `wd:season:${s.id}`, severity: 'warning', kind: 'Staffel falsch als fertig markiert',
          movieId: m.id, title: label(m),
          detail: `S${String(s.season_number).padStart(2, '0')} gilt als fertig, erfasst sind ${rows.d ?? 0} von ${s.aired_episodes} ausgestrahlten Folgen`,
        });
      }
    }
    if (m.status === 'downloaded') {
      const open = seasons.filter(s => s.status === 'pending' || s.status === 'downloading' || s.status === 'found');
      if (open.length > 0) {
        out.push({
          key: `wd:show:${m.id}`, severity: 'info', kind: 'Serie fertig, Staffel offen',
          movieId: m.id, title: label(m),
          detail: `Serie gilt als fertig, aber ${open.map(s => `S${String(s.season_number).padStart(2, '0')} (${s.status})`).join(', ')}`,
        });
      }
    }
  }
  return out;
}

// ── Rule 3: JDownloader packages nobody owns ───────────────────────────────
export function checkJdPackages(movies: Movie[], packages: JDPackage[]): WatchdogFinding[] {
  const out: WatchdogFinding[] = [];
  for (const p of packages) {
    if (!p.name || movies.some(m => jdPackageMatchesMovie(p.name, m))) continue;
    out.push({
      key: `wd:jd:${p.uuid}`, severity: 'info', kind: 'JDownloader-Paket ohne Titel',
      movieId: null, title: p.name,
      detail: 'Gehört zu keinem Titel in dlvault — von Hand hinzugefügt oder ein Rest aus einem gelöschten Eintrag',
    });
  }
  return out;
}

// ── Rule 6: the end of the chain — downloaded but not imported ─────────────
/** When each finished JD package was first seen finished (uuid → epoch ms). */
const finishedSince = new Map<number, number>();

export function checkImportStalls(movies: Movie[], packages: JDPackage[], now: number): WatchdogFinding[] {
  const out: WatchdogFinding[] = [];
  const downloading = movies.filter(m => m.status === 'downloading');
  const live = new Set<number>();
  for (const p of packages) {
    if (p.finished !== true || !p.name) continue;
    live.add(p.uuid);
    if (!finishedSince.has(p.uuid)) finishedSince.set(p.uuid, now);
    const owner = downloading.find(m => jdPackageMatchesMovie(p.name, m));
    if (!owner) continue;
    const since = finishedSince.get(p.uuid)!;
    if (now - since < HOUR) continue;      // the post-processor gets an hour
    out.push({
      key: `wd:stall:${owner.id}`, severity: 'error', kind: 'Import hängt',
      movieId: owner.id, title: label(owner),
      detail: `„${p.name}“ ist seit ${Math.round((now - since) / HOUR)} h fertig geladen, aber nicht in der Bibliothek — Download-Ordner, Pfade oder Rechte prüfen`,
    });
  }
  for (const uuid of [...finishedSince.keys()]) if (!live.has(uuid)) finishedSince.delete(uuid);

  // Nothing imported for days while titles are downloading: some stage broke.
  if (downloading.length > 0) {
    const last = db.prepare("SELECT MAX(created_at) AS at FROM activity_log WHERE action = 'moved_to_library'").get() as { at: string | null } | undefined;
    const lastAt = last?.at ? parseUtcDate(last.at) : 0;
    const oldest = Math.min(...downloading.map(m => parseUtcDate(m.updated_at || m.added_at)));
    if (now - lastAt > 72 * HOUR && now - oldest > 72 * HOUR) {
      out.push({
        key: 'wd:pipeline', severity: 'error', kind: 'Seit Tagen kein Import',
        movieId: null, title: 'Download-Kette',
        detail: `${downloading.length} Titel laden, aber seit ${lastAt ? `${Math.floor((now - lastAt) / (24 * HOUR))} Tagen` : 'Beginn'} kam nichts in der Bibliothek an`,
      });
    }
  }
  return out;
}

// ── Rule 4: leftovers in the download folder ───────────────────────────────
export function checkDownloadFolder(
  downloadPath: string | undefined, movies: Movie[], packages: JDPackage[], now: number,
): WatchdogFinding[] {
  if (!downloadPath) return [];
  const out: WatchdogFinding[] = [];
  const active = movies.filter(m => m.status !== 'downloaded' || m.repair === 1);
  const downloadsBy = getDownloadsByMovieIds(active.map(m => m.id));
  const jdTargets = new Set(packages.map(p => path.basename(p.saveTo || '')).filter(Boolean));
  const jdNames = packages.map(p => p.name).filter(Boolean);
  const entries: string[] = [];
  const list = (dir: string) => { try { return fs.readdirSync(dir); } catch { return []; } };
  for (const e of list(downloadPath)) {
    if (e.startsWith('.') || e === 'music') continue;
    if (e === 'unfertige') { for (const s of list(path.join(downloadPath, e))) if (!s.startsWith('.')) entries.push(path.join(e, s)); continue; }
    entries.push(e);
  }
  for (const rel of entries) {
    const name = path.basename(rel);
    const full = path.join(downloadPath, rel);
    // Extracted files carry the ARCHIVE's mtime (months old for a fresh
    // download); ctime is when the file appeared here. Take the later one.
    let mtime = 0;
    try { const st = fs.statSync(full); mtime = Math.max(st.mtimeMs, st.ctimeMs); } catch { continue; }
    if (now - mtime < 24 * HOUR) continue;
    if (jdTargets.has(name) || jdNames.some(n => n === name)) continue;
    // Release folder of a running title, or a JD working folder named after its
    // package — also under an older name ("Title (0) - S01" before the year was known).
    if (active.some(m => {
      const dls = downloadsBy.get(m.id) || [];
      return folderMatchesMovie(name, m, dls) || jdPackageMatchesMovie(name, m)
        || (m.media_type === 'show' && folderMatchesShow(name, m, dls));   // loose "show.s01e03…" files
    })) continue;
    out.push({
      key: `wd:dl:${rel}`, severity: 'info', kind: 'Rest im Download-Ordner',
      movieId: null, title: rel,
      detail: `Seit ${Math.floor((now - mtime) / (24 * HOUR))} Tag(en) unverändert, gehört zu keinem laufenden Download`,
    });
  }
  return out;
}

// ── Rule 5: library folder hygiene ─────────────────────────────────────────
function hasMedia(full: string): boolean {
  try {
    const st = fs.statSync(full);
    if (st.isFile()) return MEDIA_RE.test(full);
    return fs.readdirSync(full).some(f => MEDIA_RE.test(f) && !/sample/i.test(f));
  } catch { return false; }
}

/** Title + year out of "Title (2024)", "Title (2024).mkv" or "Title.2024.German.…". */
export function libraryKey(name: string): { title: string; year: string | null } {
  const base = name.replace(MEDIA_RE, '');
  const m = base.match(/^(.*?)[ ._(]+((?:19|20)\d{2})(?:[ ._)\]]|$)/);
  const raw = m ? m[1] : base.replace(/\s*\(Unknown\)$/i, '');
  return { title: normalizeTitle(raw.replace(/[._]/g, ' ')), year: m ? m[2] : null };
}

export function checkLibraryFolders(roots: { label: string; dir: string | undefined; films: boolean }[]): WatchdogFinding[] {
  const out: WatchdogFinding[] = [];
  for (const r of roots) {
    if (!r.dir) continue;
    let entries: string[];
    try { entries = fs.readdirSync(r.dir).filter(e => !e.startsWith('.')); } catch { continue; }
    for (const e of entries.filter(x => /\(Unknown\)/i.test(x))) {
      out.push({
        key: `wd:unknown:${r.label}:${e}`, severity: 'warning', kind: 'Ordner ohne Jahr',
        movieId: null, title: `${r.label}/${e}`,
        detail: 'Medienserver erkennen „(Unknown)“-Ordner oft nicht — Jahr ergänzen',
      });
    }
    if (!r.films) continue;
    const junk = entries.filter(e => {
      const full = path.join(r.dir!, e);
      try { return fs.statSync(full).isDirectory() ? JUNK_DIR_RE.test(e) : JUNK_FILE_RE.test(e); } catch { return false; }
    });
    if (junk.length > 0) {
      out.push({
        key: `wd:junk:${r.label}`, severity: 'info', kind: 'Reste in der Bibliothek',
        movieId: null, title: r.label,
        detail: `${junk.length} Eintrag/Einträge ohne Film im Hauptordner: ${junk.slice(0, 5).join(', ')}${junk.length > 5 ? ' …' : ''}`,
      });
    }
    const groups = new Map<string, string[]>();
    for (const e of entries) {
      if (!hasMedia(path.join(r.dir, e))) continue;
      const k = libraryKey(e);
      if (!k.title) continue;
      const list = groups.get(k.title) || [];
      list.push(`${e}\u0000${k.year ?? ''}`);
      groups.set(k.title, list);
    }
    for (const [title, list] of groups) {
      if (list.length < 2) continue;
      const years = new Set(list.map(x => x.split('\u0000')[1]).filter(Boolean));
      if (years.size > 1) continue;                          // same name, different films
      out.push({
        key: `wd:dup:${r.label}:${title}`, severity: 'warning', kind: 'Film doppelt in der Bibliothek',
        movieId: null, title: list[0].split('\u0000')[0],
        detail: `${list.length} Einträge: ${list.map(x => x.split('\u0000')[0]).join(' | ')}`,
      });
    }
  }
  return out;
}

/** One pass over all rules. Throttled to once an hour unless forced. */
export async function runWatchdog(now = Date.now(), force = false): Promise<WatchdogFinding[]> {
  if (!force && now - lastRunAt < HOUR - 60_000) return findings;
  lastRunAt = now;
  const movies = getAllMovies();
  const out: WatchdogFinding[] = [];
  const step = async (name: string, fn: () => Promise<WatchdogFinding[]> | WatchdogFinding[]) => {
    try { out.push(...await fn()); } catch (err: any) { logger.debug(`Watchdog ${name}: ${err?.message || err}`); }
  };
  // The post-processor's own JD snapshot (taken every 30 s while anything is
  // active, every 2 min when idle) — the watchdog adds no relay calls. Older
  // than 10 minutes means JD is unreachable: skip the JD-based rules.
  const snap = jdownloaderService.isConfigured() ? getLastJdSnapshot() : null;
  const jdKnown = !!snap && now - snap.at < 10 * 60_000;
  const packages: JDPackage[] = jdKnown ? snap!.packages : [];
  await step('server', () => checkShowsAgainstServer(movies, now));
  await step('database', () => checkDatabase(movies));
  if (jdKnown) {
    await step('jd', () => checkJdPackages(movies, packages));
    await step('stalls', () => checkImportStalls(movies, packages, now));
    await step('downloads', () => checkDownloadFolder(getSetting('paths.downloads'), movies, packages, now));
  }
  await step('library', () => checkLibraryFolders([
    { label: 'Filme', dir: getSetting('paths.movies'), films: true },
    { label: 'Serien', dir: getSetting('paths.series'), films: false },
    { label: 'Kinderfilme', dir: getSetting('paths.kids_movies'), films: true },
    { label: 'Kinderserien', dir: getSetting('paths.kids_series'), films: false },
  ]));
  findings = out;
  if (out.length > 0) logger.info(`Watchdog: ${out.length} finding(s) — ${[...new Set(out.map(f => f.kind))].join(', ')}`);
  return out;
}
