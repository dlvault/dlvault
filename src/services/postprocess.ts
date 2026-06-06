import fs from 'fs';
import path from 'path';
import { getSetting } from '../database/index';
import { getAllMovies, getMovieById, updateMovieStatus, incrementRetryCount, markJdSeen, setRemovedAt, Movie, type NotFoundReason } from '../database/services/movies';
import { countAutoBlocklisted } from '../database/services/blocklist';
import { getDownloadsByMovieIds, updateDownloadStatusByMovieId, updateDownloadStatusBySeason } from '../database/services/downloads';
import { addBlocklistEntry, isReleaseBlocklisted } from '../database/services/blocklist';
import { addLogEntry, hasRecentActivityEntry, pruneOldActivityLogs } from '../database/services/activityLog';
import { getSeasonsByShowId, updateSeasonStatus } from '../database/services/seasons';
import { markEpisodesDownloaded, getSeasonCompletionStatus, getEpisodesBySeasonId, updateEpisodeStatus } from '../database/services/episodes';
import { jdownloaderService } from '../jdownloader/index';
import type { JDPackage } from '../jdownloader/index';
import { getLibraryProvider, getLibraryProviderName } from './libraryProvider';
import { traktService } from './trakt';
import { logger } from '../utils/logger';
import { resolveMovieYear } from './metadata';
import { verifyMovieImport, verifyEpisodeLanguage, verifyEpisodesComplete } from './importCheck';
import { snapshotWatched, classifyMissing, applyMissingVerdict, moviesRootHealthy } from './libraryRemovals';
import { parseUtcDate } from '../utils/datetime';
import { sendTelegramNotification, sendTelegramSystemAlert } from './telegram';
import { eventBus } from './eventbus';
import { processingMovies, upgradingMovies, importingMovies, movingMovies, persistUpgradingMovies } from './processingState';
import type { Download } from '../database/services/downloads';
import { mergeShowFolder, type MergeResult } from './libraryMerge';

let postProcessTimer: NodeJS.Timeout | null = null;

// ── Per-cycle JDownloader snapshot ──────────────────────────────────────────
// Every JD consumer in the post-process cycle used to issue its own
// queryPackages call against the MyJDownloader CLOUD relay — 4× download-list
// + 2× linkgrabber per 30s cycle (~14k relay calls/day while completely idle),
// the exact load pattern behind the relay's transient 502/503 flapping
// (the 0.3.11 incident). Now ONE snapshot is fetched per cycle and threaded
// through every consumer. NOTE: addLinks' waitForAllOffline deliberately keeps
// its own fresh polling — its settle-detection needs consecutive fresh reads
// and must never see the same shared snapshot twice.
interface JdSnapshot { dl: JDPackage[] | null; lg: JDPackage[] | null }

// Idle gate: when dlvault has nothing 'downloading' AND the last snapshot
// showed no unfinished JD work, skip the JD poll for N cycles (= poll every
// 4th cycle / 2 min). A tracked status flipping to 'downloading' re-opens
// full-rate polling on the very next cycle; JD-side activity that appeared
// out of band (manual package) is noticed within 2 min.
const JD_IDLE_SKIP_CYCLES = 3;
let jdIdleSkipCount = 0;
let jdLastSnapshotActive = true; // true → poll (first cycle after start always polls)

/** Last complete JD answer (both lists), shared with the watchdog — no extra relay calls. */
let lastJdSnapshot: { packages: JDPackage[]; at: number } | null = null;
export function getLastJdSnapshot(): { packages: JDPackage[]; at: number } | null { return lastJdSnapshot; }

async function fetchJdSnapshot(): Promise<JdSnapshot> {
  const [dl, lg] = await Promise.all([
    jdownloaderService.getDownloadPackages().catch(() => null),
    jdownloaderService.getLinkGrabberPackages().catch(() => null),
  ]);
  if (dl && lg) lastJdSnapshot = { packages: [...dl, ...lg], at: Date.now() };
  return { dl, lg };
}

/**
 * Nudges the media server to scan, coalesced across a batch.
 *
 * A season pack finishes as many imports in a row; one scan covers all of them,
 * and hammering Jellyfin once per episode would be worse than not asking at all.
 * The delay also lets the last file settle before the scan reads the directory.
 */
let libraryRefreshTimer: NodeJS.Timeout | null = null;
const LIBRARY_REFRESH_DELAY_MS = 15_000;

/** Tests only: drop a pending debounce left behind by another test's fake timers. */
export function _resetLibraryRefresh(): void {
  if (libraryRefreshTimer) clearTimeout(libraryRefreshTimer);
  libraryRefreshTimer = null;
}

function requestLibraryRefresh(): void {
  if (libraryRefreshTimer) return;
  libraryRefreshTimer = setTimeout(() => {
    libraryRefreshTimer = null;
    // Whichever media server is in use — this only ever told Jellyfin, so on a
    // Plex install imports waited for Plex's own scheduled scan.
    getLibraryProvider().refreshLibrary().catch(() => { /* best effort by design */ });
  }, LIBRARY_REFRESH_DELAY_MS);
  if (typeof libraryRefreshTimer.unref === 'function') libraryRefreshTimer.unref();
}

/**
 * Last path segment, splitting on BOTH '/' and '\'. JDownloader reports its
 * `saveTo` in the path format of the OS it runs under. When JD runs natively on
 * Windows (e.g. dlvault in Docker Desktop, JD on the Windows host) `saveTo` is a
 * backslash path like "D:\\Downloads\\JD\\Movie". We run in a Linux container,
 * where path.basename only splits on '/', so it would return the whole string
 * and the folder-match fallback would silently fail. Splitting on both
 * separators makes the fallback robust regardless of which OS JD runs on.
 */
function lastPathSegment(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/**
 * Apply a rename template with token replacement.
 * Supported tokens: {title}, {year}, {quality}, {audio}, {season}, {episode}, {release}
 * {season} and {episode} are zero-padded to 2 digits.
 * Sanitizes output for filesystem safety.
 */
export function applyRenameTemplate(
  template: string,
  vars: {
    title: string; year: number | null; quality?: string; audio?: string;
    season?: number; episode?: number; release?: string;
    imdbId?: string | null; tmdbId?: number | null; tvdbId?: number | null;
  }
): string {
  const sanitizeVar = (v: string): string =>
    v.replace(/[\/\\]/g, ' ').replace(/\.{2,}/g, '.').trim();
  const pad2 = (n: number): string => String(n).padStart(2, '0');

  let result = template
    .replace(/\{title\}/g, sanitizeVar(vars.title))
    .replace(/\{year\}/g, vars.year ? String(vars.year) : '')
    .replace(/\{quality\}/g, sanitizeVar(vars.quality || ''))
    .replace(/\{audio\}/g, sanitizeVar(vars.audio || ''))
    .replace(/\{season\}/g, vars.season !== undefined ? pad2(vars.season) : '')
    .replace(/\{episode\}/g, vars.episode !== undefined ? pad2(vars.episode) : '')
    .replace(/\{release\}/g, sanitizeVar(vars.release || ''))
    // Provider ids. Jellyfin and Plex both read `[imdbid-tt…]` / `[tmdbid-…]` /
    // `[tvdbid-…]` out of the file or folder name and identify by it instead of
    // guessing from the title — which is how "Grell (2020)" ended up in Jellyfin
    // as Grell Island (2026-08-26).
    .replace(/\{imdbid\}/g, sanitizeVar(vars.imdbId || ''))
    .replace(/\{tmdbid\}/g, vars.tmdbId ? String(vars.tmdbId) : '')
    .replace(/\{tvdbid\}/g, vars.tvdbId ? String(vars.tvdbId) : '');

  // An id the database does not have leaves its marker behind empty:
  // "Grell (2020) [imdbid-]". Drop bracket groups that came out empty or dangling
  // on their separator, and close the gap they leave. A group with content
  // (`[{release}]`) is untouched. A missing year goes the same way: Plex and
  // Jellyfin read "Grell (Unknown)" as part of the title and matched an unrelated
  // film or nothing — the bare title, or the title with its id, matched.
  result = result
    .replace(/\[[^\]]*-\s*\]|\[\s*\]|\(\s*\)/g, '')
    // …and the separator in front of it: "{title} - {year}" → "Grell -".
    .replace(/\s+[-–]+\s*(?=$|\/|\[|\{|\s[-–])/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');

  return result
    .split('/')
    .map(segment => segment.replace(/[<>:"|?*]/g, '').replace(/\.+$/, '').trim())
    .filter(seg => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/**
 * A show whose year was completed later still has its library folder under the
 * old name ("The Show", or "The Show (Unknown)" from before); the next episode would open a second folder
 * next to it. Rename the old one to what the folder template now produces.
 * No-op for movies, when nothing exists under the old name, or when the new
 * name is already taken (never merge two folders blindly).
 */
export function renameShowFolderForYear(movie: Movie, previousYear: number | null): boolean {
  if (movie.media_type !== 'show' || !movie.year) return false;
  const root = resolveLibraryTarget(movie);
  if (!root) return false;
  const template = getSetting('rename.series_folder_template') || '{title}';
  const vars = { title: movie.title, imdbId: movie.imdb_id, tmdbId: movie.tmdb_id, tvdbId: movie.tvdb_id };
  const newDir = path.join(root, applyRenameTemplate(template, { ...vars, year: movie.year }));
  // Folders made before a missing year was left out carry "(Unknown)" instead.
  const oldDir = [
    applyRenameTemplate(template, { ...vars, year: previousYear }),
    applyRenameTemplate(template.replace(/\{year\}/g, 'Unknown'), { ...vars, year: null }),
  ].map(n => path.join(root, n)).find(d => d !== newDir && fs.existsSync(d));
  if (!oldDir || fs.existsSync(newDir)) return false;
  try {
    fs.renameSync(oldDir, newDir);
  } catch (err: any) {
    logger.warn(`${movie.title}: could not rename library folder to "${path.basename(newDir)}": ${err.message}`);
    return false;
  }
  invalidateLibraryListing();
  logger.info(`${movie.title}: library folder renamed "${path.basename(oldDir)}" → "${path.basename(newDir)}"`);
  requestLibraryRefresh();
  return true;
}

const MEDIA_EXT_RE = /\.(mkv|mp4|avi|m4v|wmv|ts)$/i;

const ID_TAG_RE = /\s*[[{](?:imdb|imdbid|tmdb|tmdbid|tvdb|tvdbid)-[^\]}]*[\]}]/gi;

/**
 * Bring a title's library entry to the name the current template gives it.
 * Names from before a template change stay behind otherwise: films named
 * "Title (Year).mkv" without the id (Plex took five of them for a short film or
 * a namesake; Jellyfin guessed right), and a
 * show folder that the next episode no longer finds — it opens a second one.
 * Both servers keep the watch state across the rename (tested 2026-10-15).
 *
 * Only an unambiguous case is touched: exactly one entry with the same title
 * and year (a show folder may lack the year), no id tag naming another title,
 * nothing under the new name yet. A film's subtitles and .nfo move along. An
 * imdb id goes into a name only once it has been checked against the tmdb id
 * (`idConfirmed`); templates with tokens that only an import knows
 * ({quality}, {audio}, {release}) or with subfolders are left alone.
 */
export function normalizeLibraryName(movie: Movie, opts: { idConfirmed: boolean }): boolean {
  const isShow = movie.media_type === 'show';
  const root = resolveLibraryTarget(movie);
  if (!root || !movie.title) return false;
  // Never while this title is being moved in: its files are not final yet.
  if (movingMovies.has(movie.id) || importingMovies.has(movie.id)) return false;
  const template = isShow
    ? getSetting('rename.series_folder_template') || '{title}'
    : getSetting('rename.movie_file_template') || '{title} ({year})';
  if (/\{(quality|audio|release|season|episode)\}|\//.test(template)) return false;
  if (/\{imdbid\}/.test(template) && !opts.idConfirmed) return false;
  if (/\{year\}/.test(template) && !movie.year) return false;
  const targetBase = applyRenameTemplate(template, {
    title: movie.title, year: movie.year,
    imdbId: movie.imdb_id, tmdbId: movie.tmdb_id, tvdbId: movie.tvdb_id,
  });
  if (!targetBase) return false;

  let names: string[];
  try { names = fs.readdirSync(root); } catch { return false; }
  const isEntry = (n: string): boolean => {
    if (n.endsWith(PART_SUFFIX)) return false;   // an import still copying
    try {
      const dir = fs.statSync(path.join(root, n)).isDirectory();
      return isShow ? dir : !dir && MEDIA_EXT_RE.test(n);
    } catch { return false; }
  };
  const ours = (base: string): boolean => {
    const ids = [...base.matchAll(/[[{](imdb|imdbid|tmdb|tmdbid|tvdb|tvdbid)-([^\]}]*)[\]}]/gi)];
    for (const [, kind, value] of ids) {
      const k = kind.toLowerCase().replace(/id$/, '');
      const mine = k === 'imdb' ? movie.imdb_id : k === 'tmdb' ? movie.tmdb_id : movie.tvdb_id;
      if (!mine || String(mine).toLowerCase() !== value.trim().toLowerCase()) return false;
    }
    const { title, year } = splitTitleYear(base.replace(ID_TAG_RE, '').replace(/\s*\(Unknown\)/i, '').trim());
    if (!sameTitle(title, movie.title)) return false;
    if (year) return year === String(movie.year);
    // Without a year only a show folder, or a name whose id already says which title it is.
    return isShow || ids.length > 0;
  };
  const baseOf = (n: string) => (isShow ? n : path.parse(n).name);
  const candidates = names.filter(n => isEntry(n) && baseOf(n) !== targetBase && ours(baseOf(n)));
  if (candidates.length !== 1) {
    if (candidates.length > 1) logger.debug(`${movie.title}: ${candidates.length} library entries could be this title — not renaming`);
    return false;
  }
  const old = candidates[0];
  const oldBase = baseOf(old);

  const target = isShow ? targetBase : `${targetBase}${path.extname(old)}`;
  if (isShow && fs.existsSync(path.join(root, target))) {
    // Both names exist: the next episode opened the current folder beside the
    // old one, and the server lists the show twice. Fold the old one in.
    let r: MergeResult;
    try { r = mergeShowFolder(path.join(root, old), path.join(root, target)); } catch (err: any) {
      logger.warn(`${movie.title}: could not merge "${old}" into "${target}": ${err.message}`);
      return false;
    }
    invalidateLibraryListing();
    logger.info(`${movie.title}: merged "${old}" into "${target}" — ${r.moved.length} moved, ${r.dropped.length} already there`
      + (r.removed ? ', old folder removed' : `, ${r.kept.length} differing file(s) left in the old folder`));
    if (r.moved.length > 0 || r.removed) requestLibraryRefresh();
    return r.moved.length > 0 || r.removed;
  }
  if (names.some(n => baseOf(n) === targetBase && isEntry(n)) || fs.existsSync(path.join(root, target))) return false;

  // A film's sidecars share its base name: "Title (2025).de.srt", "Title (2025).nfo".
  const moves: [string, string][] = [[old, target]];
  if (!isShow) {
    for (const n of names) {
      if (n === old || !n.startsWith(`${oldBase}.`) || MEDIA_EXT_RE.test(n)) continue;
      const next = targetBase + n.slice(oldBase.length);
      if (!fs.existsSync(path.join(root, next))) moves.push([n, next]);
    }
  }
  try {
    fs.renameSync(path.join(root, old), path.join(root, target));
  } catch (err: any) {
    logger.warn(`${movie.title}: could not rename "${old}" to "${target}": ${err.message}`);
    return false;
  }
  for (const [from, to] of moves.slice(1)) {
    try { fs.renameSync(path.join(root, from), path.join(root, to)); } catch { /* the media file moved; a stray sidecar is harmless */ }
  }
  invalidateLibraryListing();
  logger.info(`${movie.title}: library ${isShow ? 'folder' : 'file'} renamed "${old}" → "${target}"`);
  requestLibraryRefresh();
  return true;
}

/**
 * A corrected imdb id must reach the library too: a name tagged with the wrong
 * id makes the media server show that other film, whatever the file holds.
 * Renames every entry in the title's library root (film files and their
 * sidecars, a show's folder) that carries the old id as a tag. Names that
 * carry no id are left alone — the server matches those by title and year.
 */
export function renameLibraryForImdbId(movie: Movie, from: string, to: string): number {
  const root = resolveLibraryTarget(movie);
  if (!root || !from || !to) return 0;
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = new RegExp(`([\\[{](?:imdb|imdbid)-)${esc}([\\]}])`, 'gi');
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return 0; }
  let renamed = 0;
  for (const n of names) {
    tag.lastIndex = 0;
    if (!tag.test(n)) continue;
    const next = n.replace(tag, `$1${to}$2`);
    const target = path.join(root, next);
    if (fs.existsSync(target)) {
      logger.warn(`${movie.title}: "${n}" carries the wrong imdb id, but "${next}" already exists — left as is`);
      continue;
    }
    try {
      fs.renameSync(path.join(root, n), target);
      renamed++;
      logger.info(`${movie.title}: library entry renamed "${n}" → "${next}"`);
    } catch (err: any) {
      logger.warn(`${movie.title}: could not rename "${n}": ${err.message}`);
    }
  }
  if (renamed > 0) {
    invalidateLibraryListing();
    requestLibraryRefresh();
  }
  return renamed;
}

/**
 * Archive volumes and extraction scratch files.
 */
const ARCHIVE_OR_TEMP_RE = /\.(r\d{2}|rar|zip|7z|[0-9]{3}|rev|extracting|tmp)$/i;

/**
 * Files a downloader is still writing into.
 *
 * `part\d+` alone (the old rule) only ever matched multipart archives — it never
 * matched JDownloader's plain `<name>.mkv.part`, which is what a direct-hoster
 * download looks like for its entire lifetime. An unmatched partial file is an
 * invisible download: the folder reads as finished and both the mover and the
 * cleanup janitor are cleared to delete it mid-transfer.
 */
const PARTIAL_DOWNLOAD_RE = /\.(part\d*|!ut|dtmp|jdtmp|crdownload)$/i;

/**
 * Blocklist the most recent release we sent for a movie so the next scheduler pass
 * skips it and picks the next candidate. Without this, a release with dead hoster
 * links loops forever (source returns it → we pick it → JD marks it offline → repeat).
 */
/**
 * How many dead releases a title may burn through before the backoff kicks in.
 *
 * A release that turns out dead at the hoster says nothing about the title's
 * availability — the source usually listed several more. Counting those against
 * the retry budget made dlvault wait an hour before trying the next candidate,
 * then two, then four: a film that was obtainable took most of a day.
 *
 * The allowance is bounded, because "every candidate is dead" is a real state
 * too, and retrying that every half hour forever would never give up.
 */
const DEAD_RELEASE_BUDGET = 5;

/**
 * Records the failure without spending the retry budget, as long as there is
 * reason to believe another candidate exists.
 *
 * @returns true when the backoff was skipped.
 */
/**
 * Where a title lands when its download fails.
 *
 * A failed *upgrade* must not become 'not_found': the previous copy is still on
 * disk and perfectly watchable. Marking it missing sent it round a pointless
 * loop — the library check found the old file moments later and flipped it back
 * to 'downloaded', re-stamping downloaded_at each time, which is why such titles
 * kept reappearing at the top of "recently added".
 *
 * @returns true when this was an upgrade and the existing copy was kept.
 */
function settleFailedDownload(movie: Movie, reason: NotFoundReason): boolean {
  if (upgradingMovies.has(movie.id)) {
    upgradingMovies.delete(movie.id);
    persistUpgradingMovies();
    updateMovieStatus(movie.id, 'downloaded');
    addLogEntry(movie.id, 'upgrade_failed',
      'Quality-Upgrade fehlgeschlagen — bisherige Fassung bleibt erhalten');
    logger.info(`${movie.title}: quality upgrade failed — keeping the existing copy`);
    return true;
  }
  updateMovieStatus(movie.id, 'not_found', undefined, reason);
  return false;
}

// `why`: an import rejection (stereo, wrong language) burns a candidate the
// same way a dead release does — but was logged as "dead at the hoster".
function noteDeadRelease(movie: Movie, why = 'dead at the hoster'): boolean {
  const burned = countAutoBlocklisted(movie.id);
  if (burned >= DEAD_RELEASE_BUDGET) {
    incrementRetryCount(movie.id);
    logger.info(`${movie.title}: ${burned} releases unusable — falling back to the retry backoff`);
    return false;
  }
  logger.info(`${movie.title}: release ${why} (${burned}/${DEAD_RELEASE_BUDGET}) — trying the next candidate without backoff`);
  return true;
}

function blocklistFailedRelease(movie: Movie, downloads: Download[], reason: string): void {
  const latest = downloads[0];
  const releaseName = latest?.release_name;
  if (!releaseName) return;
  if (isReleaseBlocklisted(releaseName)) return;
  try {
    addBlocklistEntry({
      release_name: releaseName,
      title: movie.title,
      reason,
      movie_id: movie.id,
    });
    logger.info(`Blocklisted release "${releaseName}" for ${movie.title} — ${reason}`);
  } catch (err: any) {
    logger.debug(`Failed to blocklist release "${releaseName}": ${err.message}`);
  }
}

/**
 * Find the largest media file inside `dir` (scans one level of subdirs).
 * Files smaller than `minSizeMB` are ignored (samples, ads, affiliate junk).
 * Returns absolute path or null when nothing qualifies.
 */
export function pickMainMediaFile(dir: string, minSizeMB: number): string | null {
  const minBytes = Math.max(0, minSizeMB) * 1024 * 1024;
  let best: { path: string; size: number } | null = null;

  const consider = (full: string) => {
    if (!MEDIA_EXT_RE.test(full)) return;
    try {
      const size = fs.statSync(full).size;
      if (size < minBytes) return;
      if (!best || size > best.size) best = { path: full, size };
    } catch {}
  };

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        consider(full);
      } else if (entry.isDirectory()) {
        try {
          for (const sub of fs.readdirSync(full)) {
            consider(path.join(full, sub));
          }
        } catch {}
      }
    }
  } catch {}

  return best ? (best as { path: string; size: number }).path : null;
}

function getJunkMinSizeMB(): number {
  const raw = getSetting('rename.junk_min_size_mb');
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 300;
}

/**
 * Per-episode junk floor. The movie-oriented `rename.junk_min_size_mb` (300 MB
 * default) is far above a legitimate episode: a 20-minute 720p episode is
 * routinely 200-250 MB. Applying the movie threshold to a season pack made every
 * such episode invisible to the enumerator — and an invisible file is neither
 * moved nor counted, so the pack folder passed the "everything moved" check and
 * was deleted with the episodes still in it. Samples/extras sit well below this
 * floor, so 50 MB separates the two cases; a user who lowers the movie threshold
 * below that keeps their lower value.
 */
function getEpisodeMinSizeMB(): number {
  return Math.min(getJunkMinSizeMB(), 50);
}

/**
 * Parse S/E numbers from a folder or filename like "Series.S01E03.GERMAN..." or "Wardline S2E5".
 * Returns { season, episode } when both found, otherwise nulls.
 */
export function parseSeasonEpisode(name: string): { season: number | null; episode: number | null } {
  const m = name.match(/s(\d{1,2})\s*[._-]?\s*e(\d{1,3})/i);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  const sm = name.match(/[.\-\s]s(\d{1,2})/i) || name.match(/staffel[\.\-\s]*(\d+)/i);
  return { season: sm ? parseInt(sm[1], 10) : null, episode: null };
}

/**
 * JD package-name prefix exactly as the scheduler builds it: "Title (year)", or
 * just "Title" when the year is unknown. Matching against `${title} (${year})`
 * unconditionally produced the literal "Title (null)" — which the scheduler never
 * emits — so year-less movies/shows were never matched to their JD package.
 *
 * JD silently rewrites ":" to ";" in package names (Windows-filename safety).
 * Mirror that substitution so the prefix matches what JD echoes back —
 * otherwise titles like "Sandmere: Part Two" or "The Sedge: Part 2" never match
 * their own package and `syncDownloadingStatus` falsely flips them to pending
 * after the stale-reset threshold.
 */
export function jdPackagePrefix(movie: Pick<Movie, 'title' | 'year'>): string {
  const title = movie.title.replace(/:/g, ';');
  return movie.year ? `${title} (${movie.year})` : title;
}

/**
 * Does a JD package name belong to `prefix` (= jdPackagePrefix output)?
 * Requires a token boundary after the prefix so "Corvid (1979)" does not match
 * "Corvids (1986) ..." and a bare title does not match a longer title that
 * merely starts with it ("It" vs "It Chapter Two"). Valid continuations after
 * the prefix: end-of-string, " - " (separator before season/quality), " ["
 * (a tag like "[UPGRADE]"). Mirrors the matchesPrefix guard in jdownloader
 * addLinks() — that one already required this; the cross-cycle matchers here
 * historically did not.
 */
export function jdPackageMatchesPrefix(pkgName: string, prefix: string): boolean {
  if (!pkgName.startsWith(prefix)) return false;
  const rest = pkgName.slice(prefix.length);
  return rest === '' || /^(\s+-\s|\s+\[)/.test(rest);
}

/**
 * Does a JD package belong to this title, under any name dlvault may have given
 * it? A package keeps the name it was sent with, but the title's year can be
 * completed later (Seerr answered year 0 for a show without a first-air date,
 * the nightly backfill fills it in). "Wardline (0) - S01" then no longer
 * matched "Wardline (2026)": the status sync declared the running download
 * gone, reopened the season, and the next search would have sent it again.
 */
export function jdPackageMatchesMovie(pkgName: string, movie: Pick<Movie, 'title' | 'year'>): boolean {
  if (jdPackageMatchesPrefix(pkgName, jdPackagePrefix(movie))) return true;
  if (!movie.year) return false;
  return jdPackageMatchesPrefix(pkgName, jdPackagePrefix({ title: movie.title, year: 0 }))      // "Title - …" (no year)
    || jdPackageMatchesPrefix(pkgName, `${movie.title.replace(/:/g, ';')} (0)`);                  // "Title (0) - …"
}

/**
 * Classify a JD download-list package as a HARD failure, or null when it's fine.
 *
 *  - 'extraction': JD's unpacker errored — corrupt/incomplete archive, CRC
 *    mismatch, missing part, wrong password. JD flags this with
 *    statusIconKey 'extractError', or a status string that mentions extraction
 *    AND failure. The bytes are often fully downloaded, so neither the
 *    "finished → move" path nor the offline-links check catches it; without
 *    this the movie sits as "downloading" forever while the downloads page
 *    correctly shows red "Fehler".
 *  - 'download': a fatal download error surfaced in the status text that is NOT
 *    an offline-links case (those are handled by the per-link offline check).
 *
 * Deliberately conservative. Returns null for:
 *  - the live 'extract' spinner (extraction IN PROGRESS — statusIconKey
 *    'extract', or "wird entpackt"),
 *  - a successful "extractOk"/finished package,
 *  - an 'offline' status (handled elsewhere),
 *  - any plain running/waiting/finished state.
 */
/**
 * True while JD's unpacker is working on a package. A JD restart in that window
 * kills the extraction without any error status: the package then reads
 * "finished", the half-extracted files get moved, and the rest of the archive is
 * never unpacked.
 */
export function jdPackageExtracting(pkg: JDPackage): boolean {
  if ((pkg.statusIconKey || '').toLowerCase() === 'extract') return true;
  const status = (pkg.status || '').toLowerCase();
  const mentionsExtraction = status.includes('extract') || status.includes('entpack');
  return mentionsExtraction && jdPackageErrorKind(pkg) === null && !/\bok\b|erfolgreich|success/.test(status);
}

export function jdPackageErrorKind(pkg: JDPackage): 'extraction' | 'download' | null {
  const icon = (pkg.statusIconKey || '').toLowerCase();
  const status = (pkg.status || '').toLowerCase();

  // A full disk is never the release's fault — checked before everything else,
  // because JD reports it as a failed extraction ("Entpacken fehlgeschlagen:
  // nicht genug Speicherplatz") and that blocklisted good releases for good.
  // The disk guard and the problem center cover the space itself.
  if (/speicherplatz|nicht genug (freier )?platz|festplatte voll|datentr[aä]ger voll|disk full|no space|not enough (disk )?space|insufficient (disk )?space|out of space/.test(status)) {
    return null;
  }

  if (icon === 'extracterror') return 'extraction';

  const mentionsExtraction = status.includes('extract') || status.includes('entpack');
  const mentionsFailure = status.includes('error') || status.includes('fehler')
    || status.includes('fail') || status.includes('fehlgeschlagen')
    || status.includes('defekt') || status.includes('corrupt') || status.includes('crc');

  // An extraction error needs BOTH an extraction word and a failure word so the
  // benign "wird entpackt" / "extracting" progress strings never trip it.
  if (mentionsExtraction && mentionsFailure) return 'extraction';

  // Problems of the ACCOUNT or the hoster, not of the release: an expired
  // premium ("Fehler: Premium erforderlich"), a used-up traffic quota, a wait
  // time, a captcha, a busy or blocking server. Treated as a broken download,
  // each such tick removed the package and blocklisted a good release for good
  // — an expired account would have burned through the whole queue. JD retries
  // these by itself; the account monitor tells the owner.
  if (/premium|account|konto|limit|traffic|wartezeit|wait|captcha|ip[- ]?(block|gesperrt)|gesperrt|ausgelastet|busy|slot|tempor|vorübergehend|login|anmeld|credentials|zugangsdaten/.test(status)) {
    return null;
  }

  // Generic fatal download error: a failure word in the status text that is
  // neither offline (handled by the per-link check) nor an extraction string.
  if (mentionsFailure && !status.includes('offline') && !mentionsExtraction) return 'download';

  return null;
}

/**
 * Consecutive sightings of a fatal JD package error, keyed by movie id.
 *
 * Acting on the first sighting was too eager for the generic 'download' kind: a
 * hoster 503 shows up as "Fehler: Server Error" for a single 30-second tick, and
 * that was enough to pull the package from JD and write the release into the
 * blocklist — which has no expiry, so a title whose only available release hit
 * one transient error could never be downloaded again.
 *
 * Extraction errors need the same two sightings. They used to act on the first:
 * "a corrupt archive does not repair itself". But JD shows a passing extraction
 * error while it repairs a flaky RAR volume and then finishes cleanly — one such
 * tick on a 13 GB season pack blocklisted the release for good.
 */
const jdErrorSightings = new Map<number, number>();
const JD_ERROR_SIGHTINGS_REQUIRED = 2;

/** Returns true when this error has now been seen often enough to act on. */
function confirmJdError(movieId: number): boolean {
  const seen = (jdErrorSightings.get(movieId) || 0) + 1;
  jdErrorSightings.set(movieId, seen);
  return seen >= JD_ERROR_SIGHTINGS_REQUIRED;
}

/** A healthy sighting clears the streak so unrelated errors never accumulate. */
function clearJdErrorSightings(movieId: number): void {
  jdErrorSightings.delete(movieId);
}

// Track folder sizes between scans for stable-size detection (works on Windows Docker where mtime is unreliable)
const folderSizeCache = new Map<string, { size: number; stableSince: number }>();

// Move-lock: prevent concurrent move operations on the same movie

/**
 * Backoff for failed library moves (target full, share offline, permissions).
 * Every 30 s cycle used to start the whole copy again — tens of GB each time
 * onto a full disk, filling it up again and again. 5 min, doubling to 2 h;
 * cleared by the next successful move.
 */
const moveFailures = new Map<number, { count: number; nextAt: number }>();
const MOVE_BACKOFF_BASE_MS = 5 * 60 * 1000;
const MOVE_BACKOFF_MAX_MS = 2 * 60 * 60 * 1000;

function moveBlocked(movieId: number): boolean {
  const f = moveFailures.get(movieId);
  return !!f && Date.now() < f.nextAt;
}

function noteMoveFailure(movieId: number): void {
  const count = (moveFailures.get(movieId)?.count ?? 0) + 1;
  const delay = Math.min(MOVE_BACKOFF_MAX_MS, MOVE_BACKOFF_BASE_MS * 2 ** (count - 1));
  moveFailures.set(movieId, { count, nextAt: Date.now() + delay });
}

function noteMoveSuccess(movieId: number): void {
  moveFailures.delete(movieId);
}

/** Test helper. */
export function _resetMoveFailures(): void {
  moveFailures.clear();
}

/**
 * Normalize a title for fuzzy matching: lowercase, remove special chars, collapse whitespace.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A library or release name split at its year: "Grell.Diaries.2026.German…"
 * → { title: "grell diaries", year: "2026" }. The title part is what has to
 * agree with a title — "every title word appears somewhere" let "Grell
 * Diaries (2026)" stand in for "Grell" (2026).
 */
export function splitTitleYear(name: string): { title: string; year: string | null } {
  const base = name.replace(/\.(mkv|mp4|avi|m4v|wmv|ts|nfo|srt|idx|sub)$/i, '');
  // "(2017)" is our own library tag and unambiguous — use it when present.
  const paren = base.match(/^(.*?)\s*\(((?:19|20)\d{2})\)/);
  if (paren && paren[1].trim()) return { title: normalizeTitle(paren[1].replace(/\./g, ' ')), year: paren[2] };
  const norm = normalizeTitle(base.replace(/\./g, ' '));
  // Otherwise the LAST year-like token: a title may carry one of its own
  // ("… 2050", "2087", "… 1999"), and taking the first made the title end
  // early and the year wrong — such films were never found in the library.
  const last = [...norm.matchAll(/(?:^| )((?:19|20)\d{2})(?= |$)/g)].pop();
  if (!last || last.index === undefined) return { title: norm, year: null };
  const at = last.index + (last[0].startsWith(' ') ? 1 : 0);
  if (at === 0) return { title: norm, year: null };       // nothing before it: "2087" is a title, not a year
  return { title: norm.slice(0, at).trim(), year: last[1] };
}

/** Same title, ignoring how words were split ("Cronin's" vs "Cronins"). */
export function sameTitle(a: string, b: string): boolean {
  const squash = (s: string) => normalizeTitle(s).replace(/ /g, '');
  return !!squash(a) && squash(a) === squash(b);
}

/**
 * Does a library entry name belong to `title` (and `year`, when given)? The
 * title part before the year has to be the title — or one " - " segment of it,
 * for names like "A Marvel Television Special Presentation - The Punisher …".
 */
export function nameIsTitle(name: string, title: string, year: number | null): boolean {
  const { year: y } = splitTitleYear(name);
  if (year && y !== String(year)) return false;
  const candidates = [name, ...name.split(/\s[-–—]\s/).slice(1)];
  return candidates.some(c => sameTitle(splitTitleYear(c).title, title));
}

/**
 * Check if a folder name matches a movie title (fuzzy).
 * Release folders use dots: "Quiet.Ember.Leise.Glut.2026.GERMAN..."
 * We match against title words and year.
 * Accepts pre-loaded downloads to avoid N+1 queries.
 */
export function folderMatchesMovie(folderName: string, movie: Pick<Movie, 'title' | 'year'>, downloads: Pick<Download, 'release_name'>[]): boolean {
  const normalized = normalizeTitle(folderName.replace(/\./g, ' '));

  // PRIMARY: Match against release names from downloads table.
  // Release folder names are highly specific and deterministic — much safer than title matching.
  // e.g. release "Die.Stille.2024.GERMAN.1080p.WEB-DL" → folder "Die.Stille.2024.GERMAN.1080p.WEB-DL"
  for (const dl of downloads) {
    if (!dl.release_name) continue;
    const releaseNorm = normalizeTitle(dl.release_name.replace(/\./g, ' '));
    // Exact prefix match: folder normalized name starts with release normalized name
    // or release name starts with folder name (folder may be truncated)
    if (normalized.startsWith(releaseNorm) || releaseNorm.startsWith(normalized)) {
      return true;
    }
    // Also match if all significant release words (up to year) appear in the folder
    const releaseWords = releaseNorm.split(' ').filter(w => w.length > 1);
    // Find the year position to scope matching to the title part
    const yearIdx = releaseWords.findIndex(w => /^\d{4}$/.test(w));
    const titlePart = yearIdx > 0 ? releaseWords.slice(0, yearIdx + 1) : releaseWords.slice(0, 6);
    if (titlePart.length >= 2 && titlePart.every(w => normalized.includes(w))) {
      return true;
    }
  }

  // SECONDARY: Fuzzy title + year matching
  const titleNorm = normalizeTitle(movie.title);
  const titleWords = titleNorm.split(' ').filter(w => w.length > 1);

  // For very short titles (<=3 chars or single word), require year match to prevent false positives
  const isShortTitle = titleNorm.length <= 3 || titleWords.length <= 1;
  const yearMatch = !movie.year || normalized.includes(String(movie.year));

  // Short titles MUST have year match to avoid matching "Ix" to "IXEN.2026..." etc.
  if (isShortTitle && !yearMatch) return false;

  // The title must LEAD the folder's title part (a German alias may follow:
  // "Quiet.Ember.Leise.Glut.2026"). Words anywhere let a different film
  // that merely contains them be moved in as this one.
  const lead = splitTitleYear(folderName).title;
  const allWordsMatch = lead === titleNorm || lead.startsWith(`${titleNorm} `);

  // For short titles, also verify title appears as a word boundary (not substring)
  if (isShortTitle && allWordsMatch && yearMatch) {
    const words = normalized.split(' ');
    const titleFound = words.some(w => w === titleNorm);
    return titleFound;
  }

  if (allWordsMatch && yearMatch) return true;

  return false;
}

/** External subtitle formats worth carrying into the library. */
const SUBTITLE_EXT_RE = /\.(srt|sub|idx|ass|ssa|vtt)$/i;

/**
 * Move a video file's sibling subtitles alongside it, renamed to match.
 *
 * Both movers relocate ONLY the video file and then delete the container, so
 * external subtitles were destroyed with it — and German releases very commonly
 * ship forced subs as separate `.srt`/`.idx`+`.sub` files next to the video or in
 * a `Subs/` subfolder. Language suffixes are preserved
 * (`Movie.ger.forced.srt` → `Movie (2024).ger.forced.srt`) so players still
 * detect the track.
 *
 * Best-effort by design: a failure here must never fail the video move that
 * already succeeded.
 */
export async function moveCompanionSubtitles(videoSource: string, videoDest: string): Promise<number> {
  const srcDir = path.dirname(videoSource);
  const srcBase = path.basename(videoSource, path.extname(videoSource));
  const destDir = path.dirname(videoDest);
  const destBase = path.basename(videoDest, path.extname(videoDest));

  const candidates: string[] = [];
  const collect = (dir: string) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && SUBTITLE_EXT_RE.test(entry.name)) candidates.push(path.join(dir, entry.name));
      }
    } catch { /* unreadable — nothing to carry over */ }
  };
  collect(srcDir);
  // Scene releases often park them in a Subs/ or Subtitles/ subfolder.
  try {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^(subs?|subtitles?)$/i.test(entry.name)) collect(path.join(srcDir, entry.name));
    }
  } catch { /* ignore */ }

  // A season pack keeps every episode's subtitles in one folder. Only the ones
  // for THIS video may come along — before, the first episode moved swept up the
  // subtitles of all others ("S02E01.show.s02e03…idx").
  const videoSE = parseSeasonEpisode(srcBase);
  let videosInDir = 0;
  try {
    videosInDir = fs.readdirSync(srcDir).filter(n => MEDIA_EXT_RE.test(n)).length;
  } catch { /* unreadable — treated as a single-video folder */ }

  let moved = 0;
  for (const sub of candidates) {
    const subName = path.basename(sub);
    const sharesBase = subName.toLowerCase().startsWith(srcBase.toLowerCase());
    if (!sharesBase) {
      const subSE = parseSeasonEpisode(subName);
      if (subSE.episode !== null) {
        if (subSE.season !== videoSE.season || subSE.episode !== videoSE.episode) continue;
      } else if (videosInDir > 1) {
        continue; // unnamed subtitle next to several videos: no way to tell whose it is
      }
    }
    // Everything after the video's base name is the language/forced suffix.
    // A subtitle that doesn't share the base name keeps its own name.
    const suffix = sharesBase ? subName.slice(srcBase.length) : `.${subName}`;
    const dest = path.join(destDir, `${destBase}${suffix}`);
    try {
      if (fs.existsSync(dest)) continue;
      await fs.promises.mkdir(destDir, { recursive: true });
      await fs.promises.rename(sub, dest).catch(async (err: any) => {
        if (err?.code !== 'EXDEV') throw err;
        await fs.promises.copyFile(sub, dest);
        await fs.promises.rm(sub, { force: true });
      });
      moved++;
    } catch (err: any) {
      logger.debug(`Could not carry over subtitle "${subName}": ${err.message}`);
    }
  }
  return moved;
}

/**
 * Trailing qualifier tokens a release may carry between the show title and the
 * season marker: a production year ("Der.Pass.2018.S01E01"), a country tag
 * ("The.Office.US.S01E01"), or a provider-id marker on a LIBRARY folder
 * ("Wardline [imdbid-tt0000101]"). Everything else must match the title exactly.
 *
 * The id marker is the Jellyfin/Plex convention and what the series-folder
 * default writes since 2026-08-26. Without it here, findShowDir and
 * isConfirmedInLibrary stop recognising such a folder — the Endkontrolle scan
 * and the leftover-folder cleanup would quietly do nothing for that show, and
 * anyone who had already named their folders that way was affected too.
 */
const SHOW_QUALIFIER_RE = /^(\d{4}|us|uk|au|ca|nz|de|jp|kr|imdbid|tmdbid|tvdbid)$/;

/**
 * The title portion of an episode/season release name: everything before the
 * first `Sxx`/`SxxExx` marker, normalised. Returns null when there is no marker.
 */
function showTitlePart(folderName: string): string | null {
  const normalized = normalizeTitle(folderName.replace(/\./g, ' '));
  const marker = normalized.match(/\bs\d{1,2}(\s*e\d{1,3})?\b/);
  if (!marker || marker.index === undefined || marker.index === 0) return null;
  return normalized.slice(0, marker.index).trim();
}

/**
 * Does a name begin with this show's title, followed by a real boundary?
 *
 * Used where there is no `SxxExx` marker to cut at — notably JDownloader package
 * names ("Dark (2017) - S01 - 1080p"). Plain `includes()` let show "Dark" claim
 * "Dark Meridian"; requiring the very next token to be a season marker or a
 * year/country qualifier keeps sibling titles apart.
 */
export function nameStartsWithShowTitle(name: string, titleNorm: string): boolean {
  const n = normalizeTitle(name.replace(/\./g, ' '));
  if (!titleNorm) return false;
  if (n === titleNorm) return true;
  if (!n.startsWith(`${titleNorm} `)) return false;
  const next = n.slice(titleNorm.length).trim().split(' ')[0] || '';
  return SHOW_QUALIFIER_RE.test(next) || /^s\d{1,2}(e\d{1,3})?$/.test(next);
}

/**
 * Does a download folder belong to this show?
 *
 * The old rule was `titleWords.every(w => folderName.includes(w))` — a bare
 * substring test with no year and no word boundary. Show "Dark" swallowed
 * `Dark.Meridian.S01E01.…`; show "17" swallowed everything, because every release
 * name contains "h264". The mover then relocated the foreign episode into the
 * wrong series folder and DELETED the source — so the rightful show never found
 * its download.
 *
 * Episode releases are strictly named `Show.Name.SxxExx.…`, so the title portion
 * in front of the marker is an exact, cheap identity check. Release-name matching
 * from the downloads table stays the primary path (as with movies); the title
 * comparison is the fallback for folders we have no release row for.
 */
export function folderMatchesShow(
  folderName: string,
  movie: Pick<Movie, 'title' | 'year'>,
  downloads: Pick<Download, 'release_name'>[],
): boolean {
  const normalized = normalizeTitle(folderName.replace(/\./g, ' '));

  // PRIMARY: the release name we actually sent to JDownloader.
  for (const dl of downloads) {
    if (!dl.release_name) continue;
    const releaseNorm = normalizeTitle(dl.release_name.replace(/\./g, ' '));
    if (!releaseNorm) continue;
    if (normalized.startsWith(releaseNorm) || releaseNorm.startsWith(normalized)) return true;
    // A season pack's release row covers its individual episode folders too, so
    // compare the title portions rather than the whole string.
    const relTitle = showTitlePart(dl.release_name);
    const folderTitle = showTitlePart(folderName);
    if (relTitle && folderTitle && relTitle === folderTitle) return true;
  }

  // SECONDARY: exact title match on the portion before the season marker.
  const titleNorm = normalizeTitle(movie.title);
  if (!titleNorm) return false;
  const titlePart = showTitlePart(folderName);
  if (titlePart === null) {
    // No season marker at all (e.g. a folder named just after the show) — require
    // the whole name to be the title, optionally followed by qualifiers.
    return normalized === titleNorm;
  }
  if (titlePart === titleNorm) return true;
  if (!titlePart.startsWith(`${titleNorm} `)) return false;
  const rest = titlePart.slice(titleNorm.length).trim().split(' ').filter(Boolean);
  return rest.length > 0 && rest.every(w => SHOW_QUALIFIER_RE.test(w));
}

/**
 * Check if a folder (or one level of subdirectories) contains media files.
 */
function hasMediaFiles(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    // Check top-level files
    if (entries.some(f => f.isFile() && /\.(mkv|mp4|avi|m4v|wmv|ts)$/i.test(f.name))) return true;
    // Check one level of subdirectories (JD sometimes extracts into a subfolder)
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const subFiles = fs.readdirSync(path.join(dirPath, entry.name));
          if (subFiles.some(f => /\.(mkv|mp4|avi|m4v|wmv|ts)$/i.test(f))) return true;
        } catch {}
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Collect total size of media files in a directory (including one level of subdirs).
 *
 * In-progress downloads (`*.mkv.part`) count too: their bytes are what makes the
 * folder's size grow, and the size-stability check below is the only thing
 * standing between an active download and the mover/janitor. Counting only
 * finished files made a season pack whose 3rd episode was still downloading look
 * perfectly stable — the folder was moved and deleted out from under JD.
 */
function getMediaSize(dirPath: string): number {
  let totalSize = 0;
  const counts = (name: string) => MEDIA_EXT_RE.test(name) || PARTIAL_DOWNLOAD_RE.test(name);
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile() && counts(entry.name)) {
        try { totalSize += fs.statSync(fullPath).size; } catch {}
      } else if (entry.isDirectory()) {
        try {
          for (const sub of fs.readdirSync(fullPath)) {
            if (counts(sub)) {
              try { totalSize += fs.statSync(path.join(fullPath, sub)).size; } catch {}
            }
          }
        } catch {}
      }
    }
  } catch {}
  return totalSize;
}

/**
 * Recursively scan a directory for archive or extraction temp files.
 * Returns true if any .part, .rar, .zip, .7z, .001-.999, .rev, or .tmp files are found.
 */
function hasArchiveOrTempFiles(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (hasArchiveOrTempFiles(fullPath)) return true;
      } else if (
        ARCHIVE_OR_TEMP_RE.test(entry.name) || PARTIAL_DOWNLOAD_RE.test(entry.name)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a folder is still being written to (extraction in progress).
 * Looks for .part files, .rar temp files, or very recent modifications.
 */
function isStillExtracting(dirPath: string): boolean {
  try {
    // Archives/temp files present AND no extracted media yet → genuinely still
    // extracting. But once the extracted media file is on disk, lingering SOURCE
    // archives (JD with "delete archives after extraction" OFF — the default on
    // many Windows installs) must NOT read as "still extracting", or the move
    // never fires and the title hangs in 'downloading' forever. Fall through to
    // the size-stability check, which confirms the extracted media finished
    // writing. (Unraid setups delete the archives, so this only bit non-Unraid.)
    if (hasArchiveOrTempFiles(dirPath) && !hasMediaFiles(dirPath)) {
      logger.debug(`Post-processor: ${path.basename(dirPath)} has archives, no extracted media yet — still extracting`);
      return true;
    }

    // Calculate total size of media files (including subdirs)
    const totalSize = getMediaSize(dirPath);

    // Use file-size stability check (works reliably on all platforms including Windows Docker)
    const cached = folderSizeCache.get(dirPath);
    const now = Date.now();

    if (!cached || cached.size !== totalSize) {
      // Size changed or first scan — record and wait
      folderSizeCache.set(dirPath, { size: totalSize, stableSince: now });
      logger.debug(`Post-processor: ${path.basename(dirPath)} size ${(totalSize / 1024 / 1024).toFixed(0)}MB — waiting for stability`);
      return true;
    }

    // Size hasn't changed — check if stable for at least 30 seconds
    if (now - cached.stableSince < 30000) {
      return true;
    }

    // Stable for 30+ seconds — extraction complete
    return false;
  } catch {
    return false;
  }
}

// Per-package snapshot of JD state for transition detection across post-processor cycles.
// Keyed by package UUID. Pruned each cycle to packages still present in JD.
interface JdPackageSnapshot { finished: boolean; extracting: boolean; name: string }
const jdPackageState = new Map<number, JdPackageSnapshot>();

/**
 * Resolve a JD package name (e.g. "The Wardens (2019) S01 ...") to a known movie.
 * Matches the same prefix convention the scheduler uses when creating packages.
 */
function findMovieByJdPackageName(allMovies: Movie[], pkgName: string): Movie | null {
  // Pick the most specific (longest) matching prefix so a short title can't
  // shadow a longer one that the package actually belongs to.
  let best: Movie | null = null;
  let bestLen = -1;
  for (const m of allMovies) {
    const prefix = jdPackagePrefix(m);
    if (jdPackageMatchesMovie(pkgName, m) && prefix.length > bestLen) {
      best = m;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * Detect download/extraction state transitions in JDownloader and emit one log line
 * + activity_log entry per transition. Runs once per post-processor cycle.
 *
 * Transitions tracked:
 *   - download finished:   finished:false → true
 *   - extraction started:  extracting:false → true
 *   - extraction finished: extracting:true → false (and package still present)
 */
async function trackJdPackageTransitions(allMovies: Movie[], packages: JDPackage[] | null): Promise<void> {
  // null = JD unreachable / not polled this cycle — bail. Without this we'd
  // treat "no response" as "no packages" and incorrectly drop every snapshot
  // from jdPackageState as if JD had cleared them.
  if (packages === null) return;

  const seenUuids = new Set<number>();
  for (const pkg of packages) {
    seenUuids.add(pkg.uuid);
    const status = (pkg.status || '').toLowerCase();
    const extracting = status.includes('extract') || status.includes('entpack');
    const finished = pkg.finished === true;
    const prev = jdPackageState.get(pkg.uuid);

    if (finished && !prev?.finished) {
      const movie = findMovieByJdPackageName(allMovies, pkg.name);
      const sizeMB = pkg.bytesTotal ? Math.round(pkg.bytesTotal / 1024 / 1024) : null;
      const sizeStr = sizeMB !== null ? ` (${sizeMB} MB)` : '';
      logger.info(`Download finished: "${pkg.name}"${sizeStr}`);
      if (movie) addLogEntry(movie.id, 'download_finished', `Hoster-Download abgeschlossen${sizeStr}`);
    }

    if (extracting && !prev?.extracting) {
      const movie = findMovieByJdPackageName(allMovies, pkg.name);
      logger.info(`Extraction started: "${pkg.name}"`);
      if (movie) addLogEntry(movie.id, 'extraction_started', 'Entpacken gestartet');
    }

    if (!extracting && prev?.extracting) {
      const movie = findMovieByJdPackageName(allMovies, pkg.name);
      logger.info(`Extraction finished: "${pkg.name}"`);
      if (movie) addLogEntry(movie.id, 'extraction_finished', 'Entpacken abgeschlossen');
    }

    jdPackageState.set(pkg.uuid, { finished, extracting, name: pkg.name });
  }

  // Drop snapshots for packages no longer in JD (removed / cleared)
  for (const uuid of [...jdPackageState.keys()]) {
    if (!seenUuids.has(uuid)) jdPackageState.delete(uuid);
  }
}

/**
 * Move a completed download into the library and update all state. Movies move
 * their single main media file; shows are delegated to moveShowContainer +
 * applyMovedEpisodes so a season pack moves EVERY episode (never collapses to
 * the single largest file). Returns true if anything was moved. Re-entrancy and
 * notifications/trakt are handled here so all callers behave identically.
 */
async function markMovieDownloaded(
  movie: Movie, sourcePath: string, folderName: string, targetPath: string, logPrefix: string
): Promise<boolean> {
  if (movingMovies.has(movie.id)) {
    logger.debug(`${logPrefix}: ${movie.title} — move already in progress, skipping`);
    return false;
  }
  if (moveBlocked(movie.id)) {
    logger.debug(`${logPrefix}: ${movie.title} — last move failed, waiting before the next attempt`);
    return false;
  }
  movingMovies.add(movie.id);
  try {
    // The name is written once; a year the backfill has not reached yet would
    // be missing from it for good.
    if (!movie.year) movie = await resolveMovieYear(movie);
    const movieDownloads = getDownloadsByMovieIds([movie.id]).get(movie.id) || [];
    const srcStat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
    if (!srcStat) {
      logger.warn(`${logPrefix}: ${movie.title} — source path no longer exists: ${sourcePath}`);
      return false;
    }

    // ── Shows: expand the container into per-episode moves ──────────────────
    // A season pack is one folder with many SxxExx files; collapsing it to the
    // largest file (and deleting the rest) was the old data-loss bug.
    if (movie.media_type === 'show') {
      const moved = await moveShowContainer(
        movie,
        { path: sourcePath, name: folderName, isDir: srcStat.isDirectory() },
        movieDownloads, targetPath, logPrefix,
      );
      if (moved.size === 0) return false;
      applyMovedEpisodes(movie, moved, movieDownloads);
      if (traktService.isConfigured() && traktService.isAuthenticated()) {
        await traktService.markAsCollected({
          imdb_id: movie.imdb_id ?? undefined,
          tmdb_id: movie.tmdb_id ?? undefined,
          title: movie.title,
          year: movie.year ?? 0,
        });
      }
      return true;
    }

    // ── Movies: single main media file ──────────────────────────────────────
    const minJunkMB = getJunkMinSizeMB();
    const mainFile = srcStat.isFile() ? sourcePath : pickMainMediaFile(sourcePath, minJunkMB);
    if (!mainFile) {
      // No feature file >= threshold. If the movie is already downloaded AND
      // verified present in the library, this folder is leftover junk — a
      // Sample/Subs/Proof remnant left behind after the real feature was moved
      // out. Its on-disk name can differ from the stored release_name (e.g. an
      // extra ".German.": folder "Am.Kanal.German.2017…" vs release_name
      // "Am.Kanal.2017…"), so cleanupOrphanedDownloadFolders never matches
      // it while the fuzzy move-path re-claims it every cycle → an endless
      // "no media file" retry loop (the Hollin Hours case, 2026-06-07).
      // Delete it to break the loop — but only when it's truly a remnant
      // directory and the feature is confirmed in the library, so a
      // still-extracting or genuinely-incomplete download is never destroyed.
      if (srcStat.isDirectory() && movie.status === 'downloaded'
          && isConfirmedInLibrary(movie, getSetting('paths.movies'), getSetting('paths.series'))) {
        try {
          // async rm — a sync delete of a large leftover tree on FUSE/NFS
          // blocks the whole event loop (API, SSE, Telegram) for seconds.
          await fs.promises.rm(sourcePath, { recursive: true, force: true });
          folderSizeCache.delete(sourcePath);
          logger.info(`${logPrefix}: ${movie.title} — removed leftover folder "${folderName}" (no feature file; already in library)`);
        } catch (err: any) {
          logger.warn(`${logPrefix}: ${movie.title} — could not remove leftover folder ${folderName}: ${err.message}`);
        }
        return false;
      }
      logger.warn(`${logPrefix}: ${movie.title} — no media file >= ${minJunkMB}MB in ${folderName}, skipping`);
      return false;
    }
    const ext = path.extname(mainFile);
    const dlQuality = movieDownloads[0]?.quality || '';
    const dlAudio = movieDownloads[0]?.audio || '';
    const movieFileTemplate = getSetting('rename.movie_file_template') || '{title} ({year})';
    const fileBase = applyRenameTemplate(movieFileTemplate, {
      title: movie.title, year: movie.year, quality: dlQuality, audio: dlAudio, release: folderName,
      imdbId: movie.imdb_id, tmdbId: movie.tmdb_id, tvdbId: movie.tvdb_id,
    });
    const destFile = path.join(targetPath, `${fileBase}${ext}`);

    // Every film is checked before it goes in — playing time against the known
    // runtime, and (strict mode or upgrade) the audio language. A wrong film,
    // a truncated file or an English-only release used to land unnoticed; an
    // upgrade even replaced a good German copy that way.
    const isUpgrade = upgradingMovies.has(movie.id);
    const verdict = await verifyMovieImport(movie, mainFile, movieDownloads[0]?.release_name || folderName, { isUpgrade });
    if (!verdict.ok && verdict.retryLater) {
      logger.info(`${logPrefix}: ${movie.title} — file still changing (${verdict.detail}), checking again next cycle`);
      return false;
    }
    if (!verdict.ok) {
      blocklistFailedRelease(movie, movieDownloads, verdict.reason);
      try { await fs.promises.rm(sourcePath, { recursive: true, force: true }); } catch { /* best effort */ }
      folderSizeCache.delete(sourcePath);
      const keptOld = settleFailedDownload(movie, 'no_download');
      if (!keptOld) noteDeadRelease(movie, 'rejected at import');
      addLogEntry(movie.id, 'import_rejected',
        `Import abgelehnt: ${verdict.detail} — Release geblockt, ${keptOld ? 'bisherige Fassung bleibt' : 'nächster Kandidat folgt'}`);
      logger.warn(`${logPrefix}: ${movie.title} — import rejected (${verdict.detail}), release blocklisted`);
      sendTelegramNotification('error', movie.title, movie.year ?? 0,
        `Download verworfen: ${verdict.detail}. ${keptOld ? 'Die bisherige Fassung bleibt.' : 'Ich suche ein anderes Release.'}`, movie.imdb_id)
        .catch(() => { /* best effort */ });
      return true;
    }

    try {
      const moveSizeBytes = (() => { try { return fs.statSync(mainFile).size; } catch { return 0; } })();
      const moveSizeMB = Math.round(moveSizeBytes / 1024 / 1024);
      logger.info(`${logPrefix}: ${movie.title} — moving "${path.basename(mainFile)}" (${moveSizeMB} MB) → ${destFile}`);
      const moveStart = Date.now();
      // upgradingMovies is the scheduler's marker for "a [UPGRADE] download is in
      // flight for this title" — the one case where a smaller file legitimately
      // replaces a bigger one (HEVC 2160p vs x264 1080p).
      importingMovies.set(movie.id, { movieId: movie.id, startedAt: moveStart, totalBytes: moveSizeBytes, dest: destFile });
      try {
        // A repair replaces a broken copy: the size guard must not keep the
        // cut-off (larger) file and throw the complete one away.
        await moveFolder(mainFile, destFile, { isUpgrade: upgradingMovies.has(movie.id) || movie.repair === 1 });
      } finally {
        importingMovies.delete(movie.id);
      }
      if (movie.repair === 1 || upgradingMovies.has(movie.id)) removeOtherCopies(targetPath, fileBase, destFile, logPrefix, movie);
      const subsMoved = await moveCompanionSubtitles(mainFile, destFile);
      if (subsMoved > 0) logger.info(`${logPrefix}: ${movie.title} — carried over ${subsMoved} subtitle file(s)`);
      const moveDurationSec = Math.max(1, Math.round((Date.now() - moveStart) / 1000));
      const moveSpeedMBs = moveSizeMB > 0 ? Math.round(moveSizeMB / moveDurationSec) : 0;
      logger.info(`${logPrefix}: ${movie.title} — move complete (${moveSizeMB} MB in ${moveDurationSec}s${moveSpeedMBs > 0 ? `, ${moveSpeedMBs} MB/s` : ''})`);
      folderSizeCache.delete(sourcePath);

      // Source folder is junk after the main file is gone — drop the rest.
      // Only when the source was a directory (we did not just move a loose file).
      if (srcStat.isDirectory()) {
        try {
          await fs.promises.rm(sourcePath, { recursive: true, force: true });
          logger.info(`${logPrefix}: removed source folder "${folderName}"`);
        } catch (err: any) {
          logger.warn(`${logPrefix}: could not remove source folder ${folderName}: ${err.message}`);
        }
      }
      updateDownloadStatusByMovieId(movie.id, 'completed');
      updateMovieStatus(movie.id, 'downloaded');
      addLogEntry(movie.id, 'moved_to_library', `In die Mediathek verschoben: ${folderName}`);
      logger.info(`${movie.title} moved to ${destFile}`);
      noteMoveSuccess(movie.id);
      // An upgrade replaces a copy the user already has — saying "moved to the
      // library" a second time read like a duplicate download.
      const upgradeQuality = isUpgrade ? (movieDownloads[0]?.quality || '').trim() : '';
      sendTelegramNotification('download_complete', movie.title, movie.year ?? 0,
        isUpgrade
          ? `Qualitäts-Upgrade fertig${upgradeQuality ? ` — jetzt in ${upgradeQuality}` : ''}. Die bessere Fassung ersetzt die alte.`
          : `Erfolgreich in die Mediathek verschoben!`,
        movie.imdb_id);
      eventBus.emit('download:complete', { id: movie.id, title: movie.title });
      requestLibraryRefresh();

      if (traktService.isConfigured() && traktService.isAuthenticated()) {
        await traktService.markAsCollected({
          imdb_id: movie.imdb_id ?? undefined,
          tmdb_id: movie.tmdb_id ?? undefined,
          title: movie.title,
          year: movie.year ?? 0,
        });
      }
      return true;
    } catch (error: any) {
      // The download itself completed in JD — this is a filesystem error
      // (permissions, disk full, target share offline). Keep the status at
      // 'downloading' so the next cycle retries the move once the underlying
      // issue is fixed; re-searching/re-downloading would not help. Dedupe the
      // entry so a persistent failure doesn't log one line every 30s cycle —
      // previously this silently hammered the move forever with no visibility.
      noteMoveFailure(movie.id);
      if (!hasRecentActivityEntry(movie.id, 'move_failed', 1)) {
        logger.error(`${logPrefix}: failed to move ${movie.title}: ${error.message}`);
        addLogEntry(movie.id, 'move_failed', `Verschieben in die Mediathek fehlgeschlagen (neuer Versuch folgt): ${error.message}`);
      } else {
        logger.debug(`${logPrefix}: move still failing for ${movie.title}: ${error.message}`);
      }
      return false;
    }
  } finally {
    movingMovies.delete(movie.id);
  }
}

/**
 * Recursive fallback scan when no top-level folder matches a movie. Handles
 * direct-download plugins (Internet Archive, etc.) where JDownloader's
 * "move-after-extract" hook never fires because there's nothing to extract —
 * the file stays in JD's working folder (typically `unfertige/<package>/`).
 *
 * Matches by:
 *   a) basename match against expected filenames from download URLs, or
 *   b) folderMatchesMovie on any parent folder up to maxDepth
 *
 * Returns the largest matching media file or null. Files below the junk
 * threshold are skipped — same rule as the main scanner.
 */
interface DownloadFileEntry {
  fullPath: string;
  baseLower: string;
  folderName: string;
  size: number;
}

/**
 * One recursive listing of the downloads tree, shared by every movie in a cycle.
 *
 * This used to be walked per movie: `moviesToCheck` deliberately includes every
 * 'downloaded' and 'pending' title, and any of them without a matching folder
 * fell through to a fresh readdirSync/statSync walk to depth 4. With a few
 * hundred tracked titles that was six figures of blocking syscalls every 30
 * seconds — on Unraid's FUSE mount, enough to stall the event loop (and with it
 * the API, the SSE stream and the Telegram bot) for seconds at a time.
 */
function indexDownloadFiles(rootDir: string, maxDepth = 4): DownloadFileEntry[] {
  const minJunkBytes = getJunkMinSizeMB() * 1024 * 1024;
  const out: DownloadFileEntry[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: rootDir, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > maxDepth) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() && MEDIA_EXT_RE.test(e.name)) {
        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.size < minJunkBytes) continue;
        out.push({
          fullPath: full,
          baseLower: e.name.toLowerCase(),
          folderName: path.basename(dir),
          size: stat.size,
        });
      }
    }
  }
  return out;
}

/** Pick this movie's orphaned direct-download file out of the shared index. */
function findOrphanedMediaFile(
  index: DownloadFileEntry[],
  expectedBasenames: Set<string>,
  movie: Pick<Movie, 'title' | 'year'>,
  downloads: Pick<Download, 'release_name'>[],
): { sourcePath: string; folderName: string } | null {
  let best: DownloadFileEntry | null = null;
  for (const entry of index) {
    const matchesByName = expectedBasenames.has(entry.baseLower);
    const matchesByFolder = folderMatchesMovie(entry.folderName, movie, downloads);
    if (!matchesByName && !matchesByFolder) continue;
    if (!best || entry.size > best.size) best = entry;
  }
  return best ? { sourcePath: best.fullPath, folderName: best.folderName } : null;
}

/**
 * Enumerate media files inside a folder (one level deep) and parse S/E from each
 * file name, falling back to the folder name for the season. This is what lets a
 * real season pack — ONE folder containing many SxxExx files — be moved as
 * individual episodes instead of collapsing to the single largest file (which
 * the old movie-style path did, deleting the rest).
 *
 * Files below the junk threshold are flagged `belowThreshold` rather than
 * dropped: they are not moved (samples / extras / affiliate junk), but the
 * caller still needs to SEE them, because a dropped file is invisible to the
 * "did everything move?" check that authorises deleting the source folder.
 */
export interface EpisodeCandidate {
  file: string;
  season: number | null;
  episode: number | null;
  /** Below the junk floor — do not move, but do not pretend it isn't there. */
  belowThreshold: boolean;
}

export function enumerateEpisodeFiles(
  dir: string,
  folderName: string,
  minSizeMB: number,
): EpisodeCandidate[] {
  const minBytes = Math.max(0, minSizeMB) * 1024 * 1024;
  const folderSE = parseSeasonEpisode(folderName);
  const out: EpisodeCandidate[] = [];

  const consider = (full: string) => {
    if (!MEDIA_EXT_RE.test(full)) return;
    let size: number;
    try { size = fs.statSync(full).size; } catch { return; }
    const fileSE = parseSeasonEpisode(path.basename(full));
    out.push({
      file: full,
      season: fileSE.season ?? folderSE.season,
      episode: fileSE.episode ?? folderSE.episode,
      belowThreshold: size < minBytes,
    });
  };

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      consider(full);
    } else if (entry.isDirectory()) {
      try { for (const sub of fs.readdirSync(full)) consider(path.join(full, sub)); } catch {}
    }
  }
  return out;
}

/**
 * One file per episode. A pack can carry a sample next to each episode
 * ("Sample/…s04e01…-sample.mkv", 80 MB — above the junk floor): both mapped to
 * the same S/E, so the sample was moved into the library first and the real
 * episode replaced it seconds later — or, had the episode failed to move, the
 * sample would have stayed as the episode. Samples never count; of several
 * files for one episode the largest wins. Unmapped files pass through.
 */
export function pickEpisodeFiles(cands: EpisodeCandidate[]): { keep: EpisodeCandidate[]; duplicates: EpisodeCandidate[] } {
  const size = (f: string): number => { try { return fs.statSync(f).size; } catch { return 0; } };
  const isSample = (f: string) => SAMPLE_RE.test(path.basename(f)) || SAMPLE_RE.test(path.basename(path.dirname(f)));
  const best = new Map<string, { c: EpisodeCandidate; bytes: number }>();
  const keep: EpisodeCandidate[] = [];
  const duplicates: EpisodeCandidate[] = [];
  for (const c of cands) {
    if (c.season === null || c.episode === null || c.episode === undefined) { keep.push(c); continue; }
    const key = `${c.season}x${c.episode}`;
    const bytes = isSample(c.file) ? -1 : size(c.file);
    const cur = best.get(key);
    if (!cur) { best.set(key, { c, bytes }); continue; }
    if (bytes > cur.bytes) { duplicates.push(cur.c); best.set(key, { c, bytes }); }
    else duplicates.push(c);
  }
  // A lone sample with no real file beside it stays a candidate: better a
  // visible short file than silently deleting the only copy with the folder.
  for (const { c } of best.values()) keep.push(c);
  // Episode order, so the language check reads a real first episode.
  keep.sort((a, b) => (a.season ?? 999) - (b.season ?? 999) || (a.episode ?? 999) - (b.episode ?? 999));
  return { keep, duplicates };
}

export interface ShowSource { path: string; name: string; isDir: boolean; }

/**
 * Move every episode media file out of one source container — a season-pack
 * folder (many SxxExx files), an episode folder (one file), or a loose top-level
 * file — into the series library, renaming per the templates. Returns the
 * season → episode-numbers actually moved. Deletes a source *folder* only when
 * every episode planned from it moved (no premature deletion / data loss).
 * Pure mover: it does NOT touch DB state — the caller owns that via
 * applyMovedEpisodes so multiple containers can be aggregated into one update.
 */
async function moveShowContainer(
  movie: Movie,
  container: ShowSource,
  downloads: Download[],
  targetPath: string,
  logPrefix: string,
): Promise<Map<number, Set<number>>> {
  const moved = new Map<number, Set<number>>();

  if (moveBlocked(movie.id)) {
    logger.debug(`${logPrefix}: ${movie.title} — last move failed, waiting before the next attempt`);
    return moved;
  }
  if (container.isDir && (!hasMediaFiles(container.path) || isStillExtracting(container.path))) {
    logger.debug(`${logPrefix}: "${container.name}" not ready yet (no media / still extracting)`);
    return moved;
  }

  const minJunkMB = getEpisodeMinSizeMB();
  const folderSE = parseSeasonEpisode(container.name);
  const allCandidates: EpisodeCandidate[] = container.isDir
    ? enumerateEpisodeFiles(container.path, container.name, minJunkMB)
    : [{ file: container.path, ...parseSeasonEpisode(container.name), belowThreshold: false }];
  const { keep: candidates, duplicates } = pickEpisodeFiles(allCandidates.filter(c => !c.belowThreshold));
  const tooSmall = allCandidates.filter(c => c.belowThreshold);
  for (const d of duplicates) {
    logger.debug(`${logPrefix}: ${movie.title} — "${path.basename(d.file)}" duplicates an episode file in "${container.name}" (sample/extra), not moved`);
  }

  // Language check on the first episode (strict mode): a pack is one release —
  // if its first episode carries no wanted-language track, none do. Runtime is
  // not judged for episodes; per-episode lengths are not reliably known.
  if (candidates.length > 0) {
    let verdict = await verifyEpisodesComplete(candidates.map(c => c.file));
    if (!verdict.ok && verdict.retryLater) {
      logger.info(`${logPrefix}: ${movie.title} — ${verdict.detail}; file still changing, checking again next cycle`);
      return moved;
    }
    if (verdict.ok) verdict = await verifyEpisodeLanguage(candidates[0].file);
    if (!verdict.ok) {
      const season = candidates[0].season ?? folderSE.season;
      const seasonDownloads = downloads.filter(d => season == null || d.season_number == null || d.season_number === season);
      blocklistFailedRelease(movie, seasonDownloads, verdict.reason);
      try { await fs.promises.rm(container.path, { recursive: true, force: true }); } catch { /* best effort */ }
      folderSizeCache.delete(container.path);
      if (season != null) {
        const dbSeason = getSeasonsByShowId(movie.id).find(x => x.season_number === season);
        if (dbSeason) updateSeasonStatus(dbSeason.id, 'pending');
      }
      const label = season != null ? `S${String(season).padStart(2, '0')}` : container.name;
      addLogEntry(movie.id, 'import_rejected', `${label}: Import abgelehnt — ${verdict.detail}; Release geblockt, neue Suche folgt`);
      logger.warn(`${logPrefix}: ${movie.title} ${label} — import rejected (${verdict.detail}), release blocklisted`);
      sendTelegramNotification('error', movie.title, movie.year ?? 0,
        `${label} verworfen: ${verdict.detail}. Ich suche ein anderes Release.`, movie.imdb_id)
        .catch(() => { /* best effort */ });
      return moved;
    }
  }

  const seriesFolderTemplate = getSetting('rename.series_folder_template') || '{title}';
  const seriesFileTemplate = getSetting('rename.series_file_template') || '{title} S{season}E{episode}';
  const dlQuality = downloads[0]?.quality || '';
  const dlAudio = downloads[0]?.audio || '';

  let planned = 0;
  let done = 0;
  let skippedMedia = 0;
  const fileBytes = (f: string): number => { try { return fs.statSync(f).size; } catch { return 0; } };
  const importState = {
    movieId: movie.id, startedAt: Date.now(), dest: '', doneBytes: 0,
    totalBytes: candidates.reduce((sum, c) => sum + fileBytes(c.file), 0),
  };
  importingMovies.set(movie.id, importState);
  try {
    for (const c of candidates) {
      const season = c.season ?? folderSE.season;
      const episode = c.episode;
      if (season === null || episode === null || episode === undefined) {
        // These candidates are already confirmed media files >= the junk threshold
        // (enumerateEpisodeFiles filtered them). We can't place a file we can't map
        // to an S/E — count it so the source folder is NOT deleted below, otherwise
        // the unmapped episode would be silently destroyed with the folder.
        logger.warn(`${logPrefix}: ${movie.title} — could not parse S/E from "${path.basename(c.file)}" in "${container.name}" — leaving file in place`);
        skippedMedia++;
        continue;
      }
      planned++;
      const seriesDir = applyRenameTemplate(seriesFolderTemplate, {
        title: movie.title, year: movie.year, quality: dlQuality, audio: dlAudio,
        season, episode, release: container.name,
        imdbId: movie.imdb_id, tmdbId: movie.tmdb_id, tvdbId: movie.tvdb_id,
      });
      const seasonDir = path.join(targetPath, seriesDir);
      if (!fs.existsSync(seasonDir)) fs.mkdirSync(seasonDir, { recursive: true });
      const fileBase = applyRenameTemplate(seriesFileTemplate, {
        title: movie.title, year: movie.year, quality: dlQuality, audio: dlAudio,
        season, episode, release: container.name,
        imdbId: movie.imdb_id, tmdbId: movie.tmdb_id, tvdbId: movie.tvdb_id,
      });
      const dest = path.join(seasonDir, `${fileBase}${path.extname(c.file)}`);
      try {
        const epBytes = fileBytes(c.file);
        const epSizeMB = Math.round(epBytes / 1024 / 1024);
        importState.dest = dest;
        await moveFolder(c.file, dest);
        importState.doneBytes += epBytes;
        await moveCompanionSubtitles(c.file, dest);
        logger.info(`${logPrefix}: ${movie.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}: moved (${epSizeMB} MB) → ${dest}`);
        if (!moved.has(season)) moved.set(season, new Set());
        moved.get(season)!.add(episode);
        done++;
        noteMoveSuccess(movie.id);
      } catch (err: any) {
        logger.error(`${logPrefix}: ${movie.title} — failed to move "${path.basename(c.file)}": ${err.message}`);
        // One failure stops this container: the next episode would hit the same
        // full disk / offline share. The backoff decides when to try again.
        noteMoveFailure(movie.id);
        break;
      }
    }
  } finally {
    importingMovies.delete(movie.id);
  }

  // Sub-threshold media that we did NOT move: a sample duplicates an episode we
  // already placed (or has no S/E at all) and is safe to delete with the folder.
  // A file carrying an S/E that nothing else covered is a real, small episode —
  // deleting the folder would destroy it, so block the removal instead.
  for (const c of tooSmall) {
    const season = c.season ?? folderSE.season;
    const episode = c.episode;
    if (season === null || episode === null || episode === undefined) continue; // sample / extra
    if (moved.get(season)?.has(episode)) continue;                              // sample of a placed episode
    logger.warn(
      `${logPrefix}: ${movie.title} — "${path.basename(c.file)}" is below the ${minJunkMB} MB floor but maps to ` +
      `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} which nothing else covered — keeping the source folder`,
    );
    skippedMedia++;
  }

  // Remove the source folder only when every planned episode moved AND no media
  // file was left behind unmapped — deleting with skipped media = data loss.
  if (container.isDir && planned > 0 && done === planned && skippedMedia === 0) {
    folderSizeCache.delete(container.path);
    try { await fs.promises.rm(container.path, { recursive: true, force: true }); }
    catch (e: any) { logger.warn(`${logPrefix}: could not remove source folder ${container.name}: ${e.message}`); }
  } else if (container.isDir && skippedMedia > 0 && done === planned) {
    logger.warn(`${logPrefix}: ${movie.title} — kept source folder "${container.name}": ${skippedMedia} media file(s) had no parseable S/E`);
  }
  return moved;
}

/**
 * Apply the result of one or more moveShowContainer() calls to the DB: mark ONLY
 * the delivered episodes downloaded, recompute each touched season's status from
 * its own episode set (so a partial season stays 'downloading', never falsely
 * 'downloaded'), then roll the aggregate show status up and notify on transition.
 */
function applyMovedEpisodes(movie: Movie, movedBySeason: Map<number, Set<number>>, downloads: Download[]): void {
  if (movedBySeason.size === 0) return;
  // Only the movie path asked the media server to rescan; episodes appeared
  // whenever Jellyfin happened to scan on its own — 84 of 92 freshly moved
  // episodes of one show were still missing an hour later.
  requestLibraryRefresh();

  const seasons = getSeasonsByShowId(movie.id);
  for (const [sNum, epNums] of movedBySeason) {
    const season = seasons.find(s => s.season_number === sNum);
    if (!season) {
      // Season pack for a season Trakt never told us about — no row to attach to.
      // The scheduler/libraryReconcile will create + reconcile it on the next sync.
      logger.warn(`${movie.title} S${String(sNum).padStart(2, '0')}: moved ${epNums.size} episode(s) but season is unknown to DB`);
      continue;
    }
    // The release of THIS season — downloads[0] is whatever row came first, so
    // S04 episodes were recorded under the S02 pack's name.
    const release = downloads.find(d => d.season_number === sNum)?.release_name ?? downloads[0]?.release_name;
    markEpisodesDownloaded(season.id, [...epNums], release ?? undefined);
    const completion = getSeasonCompletionStatus(season.id);
    updateSeasonStatus(season.id, completion.allDone ? 'downloaded' : 'downloading');
    addLogEntry(movie.id, 'moved_to_library',
      `S${String(sNum).padStart(2, '0')}: ${epNums.size} episode(s) moved to library${completion.total > 0 ? ` (${completion.downloaded}/${completion.total})` : ''}`);
    logger.info(`${movie.title} S${String(sNum).padStart(2, '0')}: ${epNums.size} episode(s) moved (${completion.downloaded}/${completion.total} done)`);
    if (completion.rowsDone && !completion.allDone) {
      logger.warn(`${movie.title} S${String(sNum).padStart(2, '0')}: only ${completion.downloaded} of ${completion.total} aired episodes arrived — season stays open`);
    }
    // Only THIS season's download rows. The unscoped update marked every season
    // of the show 'completed' the moment any one of them landed, which erased
    // the one signal the JD retry path has for "this season still needs sending".
    updateDownloadStatusBySeason(movie.id, sNum, 'completed');
  }
  // Legacy/movie-shaped rows for this show carry no season_number — nothing else
  // will ever close those out, so mark them here.
  updateDownloadStatusBySeason(movie.id, null, 'completed');

  const allSeasons = getSeasonsByShowId(movie.id);
  const allDone = allSeasons.length > 0 && allSeasons.every(s => s.status === 'downloaded');
  if (allDone) {
    const wasAlreadyDownloaded = movie.status === 'downloaded';
    updateMovieStatus(movie.id, 'downloaded');
    if (!wasAlreadyDownloaded) {
      sendTelegramNotification('download_complete', movie.title, movie.year ?? 0, 'Alle Staffeln heruntergeladen', movie.imdb_id);
      eventBus.emit('download:complete', { id: movie.id, title: movie.title });
    }
  } else if (allSeasons.some(s => s.status === 'downloading') && movie.status !== 'downloading') {
    updateMovieStatus(movie.id, 'downloading');
  }
  eventBus.emit('movie:updated', { id: movie.id, title: movie.title });
}

// Remember which bad path values we've already warned about so the post-process
// pass (runs every cycle) logs each misconfiguration once, not on every tick.
const warnedBadPaths = new Set<string>();

/**
 * Loudly flag a misconfigured container path. dlvault runs inside a Linux
 * container, so paths.downloads/movies/series must be CONTAINER mount paths
 * (e.g. /movies) — a Windows host path like "C:\Media" doesn't exist in the
 * container and the move/scan fails silently. The single biggest "pipeline looks
 * dead" trap on Windows. Warns once per distinct bad value.
 */
function warnIfBadContainerPath(label: string, p: string | undefined): void {
  if (!p) return;
  const looksWindows = /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\');
  const missing = !looksWindows && !fs.existsSync(p);
  if (!looksWindows && !missing) return;
  const key = `${label}:${p}`;
  if (warnedBadPaths.has(key)) return;
  warnedBadPaths.add(key);
  if (looksWindows) {
    logger.warn(`Path ${label}="${p}" looks like a Windows path. dlvault runs in a Linux container — set the CONTAINER mount path (e.g. /movies), not a Windows path. Moves/scans to this path will fail silently.`);
  } else {
    logger.warn(`Path ${label}="${p}" does not exist inside the container. Check the Docker volume is mounted and the value matches the container mount (e.g. /movies).`);
  }
}

// Remembers which JD saveTo paths we've already flagged, so the mount-mismatch
// diagnostic logs each misconfiguration once rather than every 30s cycle.
const warnedDownloadMounts = new Set<string>();

/** saveTo's last 2–3 path segments exist under dlvault's download dir. */
export function visibleBelowDownloadPath(saveTo: string, downloadPath: string): boolean {
  const segs = saveTo.split(/[\\/]+/).filter(Boolean);
  for (let k = 2; k <= Math.min(3, segs.length); k++) {
    try {
      if (fs.existsSync(path.join(downloadPath, ...segs.slice(-k)))) return true;
    } catch { /* unreadable — keep looking */ }
  }
  return false;
}

/**
 * Self-diagnostic for the single most confusing setup mistake: dlvault learns a
 * download "finished" / "extracting" from JDownloader's API (so it logs those),
 * but it can only MOVE files it can actually see on disk in `downloadPath`. If JD
 * downloads to a folder that ISN'T the host folder mounted as /downloads, finished
 * packages never get moved or renamed — silently. Warn loudly (once per saveTo)
 * when a finished package's output folder isn't visible in the download directory.
 */
function diagnoseDownloadMountMismatch(
  dlPackages: JDPackage[],
  downloadFolders: string[],
  downloadPath: string,
  downloadingMovies: Movie[],
  downloadsByMovie: Map<number, Download[]>,
): void {
  const rootName = path.basename(downloadPath.replace(/[\\/]+$/, ''));
  for (const pkg of dlPackages) {
    if (!pkg.finished || !pkg.saveTo) continue;
    const folder = lastPathSegment(pkg.saveTo);
    // `folder === rootName` guards the "JD writes straight into the root, no
    // per-package subfolder" config — there the saveTo IS the download dir.
    if (!folder || folder === rootName || downloadFolders.includes(folder)) continue;
    // JD's "unfinished" subfolder (".../unfertige/<package>"): the package sits
    // one level down until extraction writes the result to the top level. That
    // is visible to dlvault, so not a mount problem — the import worked, and the
    // warning was a false alarm on every such setup.
    if (visibleBelowDownloadPath(pkg.saveTo, downloadPath)) continue;

    // JD names the package folder after the PACKAGE ("Second Glance (2024)"), but
    // the files land in a RELEASE-named folder ("Blink.Twice.2024…GROUP"), so the
    // exact check above misses on virtually every download. Before crying "mount
    // mismatch", apply the SAME release-aware match the post-processor uses to
    // actually move the files — if it would find the folder, the mount is fine
    // and this is just a naming difference, not a misconfiguration. Only the
    // genuine "JD writes where dlvault can't see" case (no matching folder at
    // all) should warn. Without this, the diagnostic cried wolf on EVERY
    // finished download even though the move succeeded seconds later.
    const movie = downloadingMovies.find(m => jdPackageMatchesMovie(pkg.name || '', m));
    // A package dlvault did not send (added by hand in JD) is none of its
    // business: where it lands, and whether the user already moved it, says
    // nothing about dlvault's mount. Those were the only warnings it produced.
    if (!movie) continue;
    const movieDownloads = downloadsByMovie.get(movie.id) || [];
    if (downloadFolders.some(f => folderMatchesMovie(f, movie, movieDownloads))) continue;

    if (warnedDownloadMounts.has(pkg.saveTo)) continue;
    warnedDownloadMounts.add(pkg.saveTo);
    logger.warn(
      `Download mount mismatch: JDownloader finished "${pkg.name}" into "${pkg.saveTo}", but "${folder}" is not in ` +
      `dlvault's download directory "${downloadPath}". dlvault sees JD's status over the API but can only MOVE files it ` +
      `can access on disk — JD's download folder must be the SAME host folder that is mounted as /downloads in dlvault, ` +
      `or nothing gets moved/renamed.`,
    );
  }
}

/**
 * Does this title route to the optional kids library? True when any of its genres
 * matches the configured kids genres (kids.genres, default "Family,Animation").
 * Empty/unfetched genres → false (lands in the normal library).
 */
export function isKidsContent(movie: Movie): boolean {
  const titleGenres = (movie.genres || '').toLowerCase().split(',').map(g => g.trim()).filter(Boolean);
  if (titleGenres.length === 0) return false;
  const kidsGenres = (getSetting('kids.genres') || 'Family,Animation')
    .toLowerCase().split(',').map(g => g.trim()).filter(Boolean);
  return kidsGenres.length > 0 && titleGenres.some(g => kidsGenres.includes(g));
}

/**
 * Where a finished title is moved: the optional kids library
 * (paths.kids_movies / paths.kids_series) when its genres match the kids genres
 * AND that path is set, otherwise the normal library. Returns null when neither
 * is configured (callers already warn + skip on null).
 */
export function resolveLibraryTarget(movie: Movie): string | null {
  const isShow = movie.media_type === 'show';
  if (isKidsContent(movie)) {
    const kidsPath = getSetting(isShow ? 'paths.kids_series' : 'paths.kids_movies');
    if (kidsPath) return kidsPath;
  }
  return getSetting(isShow ? 'paths.series' : 'paths.movies') || null;
}

async function checkCompletedDownloads(allMovies: Movie[], downloadsByMovie: Map<number, Download[]>, jdDlPackages: JDPackage[] | null): Promise<void> {
  const downloadPath = getSetting('paths.downloads');
  const moviesPath = getSetting('paths.movies');
  const seriesPath = getSetting('paths.series');

  warnIfBadContainerPath('paths.downloads', downloadPath);
  warnIfBadContainerPath('paths.movies', moviesPath);
  warnIfBadContainerPath('paths.series', seriesPath);
  warnIfBadContainerPath('paths.kids_movies', getSetting('paths.kids_movies'));
  warnIfBadContainerPath('paths.kids_series', getSetting('paths.kids_series'));

  if (!downloadPath || (!moviesPath && !seriesPath)) return;

  // SHOWS are ALWAYS scanned: a show can be flagged 'not_found' by a fruitless
  // source search even while earlier seasons are fully downloaded and sitting in
  // /downloads (e.g. a finished S01 pack the show flipped past). Excluding them
  // here stranded those files. MOVIES keep the cheap not_found skip — a
  // never-downloaded movie has nothing on disk to move. 'downloaded' items are
  // cheap to skip when no folder is found, and including them ensures orphaned
  // folders get moved after a restart.
  const moviesToCheck = allMovies.filter(m => m.media_type === 'show' || m.status !== 'not_found');
  if (moviesToCheck.length === 0) return;

  // JD packages come from the shared per-cycle snapshot: used to skip shows
  // whose package is still busy (downloading OR extracting). Moving a
  // still-growing episode file truncates it — the "plays to half then stops"
  // bug. null = JD unreachable or not polled this idle cycle; then we can't
  // know finished-state, so we fall back to the on-disk size-stability
  // heuristic only (unchanged behaviour when JD is down).
  const jdReachable = jdDlPackages !== null;
  const jdPkgList = jdDlPackages || [];

  try {
    if (!fs.existsSync(downloadPath)) return;

    const allEntries = fs.readdirSync(downloadPath, { withFileTypes: true });
    const folders = allEntries.filter(d => d.isDirectory()).map(d => d.name);
    // Use the shared media-extension set — a private narrower regex here meant
    // loose top-level .wmv/.ts files were invisible to the show/movie matchers.
    const files = allEntries.filter(d => d.isFile() && MEDIA_EXT_RE.test(d.name)).map(d => d.name);

    logger.debug(`Post-processor: scanning ${folders.length} folders + ${files.length} media files in ${downloadPath}, ${moviesToCheck.length} movies to check`);

    // Built lazily: only movies with no matching top-level folder need it, and on
    // a healthy install that is nobody. Built at most ONCE per cycle either way.
    let downloadFileIndex: DownloadFileEntry[] | null = null;
    const getDownloadFileIndex = (): DownloadFileEntry[] => {
      if (downloadFileIndex === null) {
        const t0 = Date.now();
        downloadFileIndex = indexDownloadFiles(downloadPath);
        logger.debug(`Post-processor: indexed ${downloadFileIndex.length} media file(s) under ${downloadPath} in ${Date.now() - t0}ms`);
      }
      return downloadFileIndex;
    };

    for (const movie of moviesToCheck) {
      if (processingMovies.has(movie.id)) continue;

      const downloads = downloadsByMovie.get(movie.id) || [];

      // ── Shows: move every delivered episode individually ──────────────────
      // A season can arrive as: loose top-level SxxExx files, one folder per
      // episode, OR a single season-pack folder holding many SxxExx files. All
      // three are expanded to per-episode moves so a pack never collapses to its
      // largest file (the old bug deleted the rest), and only the episodes we
      // actually move are marked downloaded (a partial season stays open).
      if (movie.media_type === 'show') {
        const targetPath = resolveLibraryTarget(movie);
        if (!targetPath) {
          logger.warn(`Post-processor: ${movie.title} is a show but paths.series is not configured`);
          continue;
        }
        const titleWords = normalizeTitle(movie.title).split(' ').filter(w => w.length > 1);
        if (titleWords.length === 0) continue;
        const matchesShowTitle = (name: string): boolean => folderMatchesShow(name, movie, downloads);

        // Hold off while JDownloader still has a BUSY package for this show — one
        // that hasn't finished downloading, or is mid-extraction (JD can flag a
        // package finished=true while its Extraction extension is still running).
        // Moving now would grab a half-written file and truncate it ("plays to
        // half then stops"). An errored package blocks too: its output folder holds
        // whatever the failed extraction got to, and moving that puts a truncated
        // file in the library. syncDownloadingStatus removes it after the second
        // sighting and clears the partial output. When JD is unreachable or has no matching package (an orphaned folder it
        // already cleared), we fall through to the size-stability heuristic.
        // Per season: a show with several seasons in JD used to block ALL of
        // them while any one was still loading — finished, extracted seasons sat
        // in the download folder for as long as another season's 60 GB took.
        // A busy package without a season in its name still blocks everything.
        const showTitleNorm = normalizeTitle(movie.title);
        const busySeasons = new Set<number>();
        let busyWholeShow = false;
        if (jdReachable) {
          for (const p of jdPkgList) {
            if (!nameStartsWithShowTitle(p.name || '', showTitleNorm)) continue;
            const s = (p.status || '').toLowerCase();
            const extracting = s.includes('extract') || s.includes('entpack');
            const busy = jdPackageErrorKind(p) !== null || p.finished !== true || extracting;
            if (!busy) continue;
            const season = parseSeasonEpisode((p.name || '').replace(/\s-\s/g, '.')).season;
            if (season === null) busyWholeShow = true;
            else busySeasons.add(season);
          }
        }
        if (busyWholeShow) {
          logger.debug(`${movie.title}: JDownloader package still busy (downloading/extracting) — waiting before move`);
          continue;
        }
        const seasonBusy = (name: string): boolean => {
          if (busySeasons.size === 0) return false;
          const season = parseSeasonEpisode(name).season;
          return season === null || busySeasons.has(season);
        };

        const EP_RE = /s\d{1,2}\s*e\d{1,3}/i;

        // Source containers belonging to this show.
        const sources: ShowSource[] = [];
        for (const f of files) {
          if (matchesShowTitle(f) && EP_RE.test(f) && !seasonBusy(f)) {
            sources.push({ path: path.join(downloadPath, f), name: f, isDir: false });
          }
        }
        for (const f of folders) {
          const isEpFolder = matchesShowTitle(f) && EP_RE.test(f);
          const isShowFolder = folderMatchesMovie(f, movie, downloads)
            || (matchesShowTitle(f) && parseSeasonEpisode(f).season !== null);
          if ((isEpFolder || isShowFolder) && !seasonBusy(f)) {
            sources.push({ path: path.join(downloadPath, f), name: f, isDir: true });
          }
        }
        if (sources.length === 0 && busySeasons.size > 0) {
          logger.debug(`${movie.title}: only seasons still busy in JDownloader have output — waiting`);
          continue;
        }

        if (sources.length === 0) {
          const dbSeasons = getSeasonsByShowId(movie.id);
          const allComplete = dbSeasons.length > 0 && dbSeasons.every(s => s.status === 'downloaded');
          if (allComplete && movie.status !== 'downloaded') {
            // Every season is downloaded but the show carries a stale, non-downloaded
            // status — e.g. a fruitless source search clobbered it to not_found/
            // quality_mismatch AFTER the files had already landed. Heal it so it
            // leaves the "Keine passende Qualität" / "Nicht gefunden" buckets.
            // (updateMovieStatus clears not_found_reason on the transition.)
            updateMovieStatus(movie.id, 'downloaded');
            logger.info(`Post-processor: ${movie.title} — all seasons complete, corrected stale '${movie.status}' → downloaded`);
          } else if (movie.status === 'downloaded') {
            // Same rules as the reconcile pass: seasons below the cutoff stay
            // 'pending' for good (they were marked 'downloaded' here with no file
            // behind them), and a 'pending' season the user wants was REOPENED on
            // purpose (missing episodes, repair) — closing it here undid every
            // reopen within 30 s. Only a 'downloading' season with nothing left in
            // JD or on disk is stale.
            const monitored = dbSeasons.filter(s => !movie.season_cutoff || s.season_number >= movie.season_cutoff);
            // Only AIRED seasons: an announced next season sits 'pending' with 0
            // aired episodes and must not pull a complete show back into the queue.
            const reopened = monitored.filter(s => s.status === 'pending' && (s.aired_episodes ?? 1) > 0);
            const stuckSeasons = monitored.filter(s => s.status === 'downloading');
            if (reopened.length > 0) {
              updateMovieStatus(movie.id, 'pending');
              logger.info(`Post-processor: "${movie.title}" back to 'pending' — ${reopened.length} season(s) reopened`);
            } else if (stuckSeasons.length > 0) {
              for (const s of stuckSeasons) updateSeasonStatus(s.id, 'downloaded');
              logger.info(`Post-processor: fixed ${stuckSeasons.length} stuck season(s) for "${movie.title}" (show already downloaded)`);
            }
          } else if (movie.status === 'downloading') {
            logger.debug(`Post-processor: NO match for show "${movie.title}" — ${folders.length} folders, ${files.length} files`);
          }
          continue;
        }

        // Commit DB state after EACH container. moveShowContainer deletes the
        // source folder once its episodes are in the library; committing only at
        // the end of the pass meant a restart mid-pass (five season packs take
        // ~20 min) left moved seasons unrecorded with their source gone — the
        // stale sync then reopened them and they were downloaded again.
        if (movingMovies.has(movie.id)) continue;
        movingMovies.add(movie.id);
        try {
          for (const source of sources) {
            const moved = await moveShowContainer(movie, source, downloads, targetPath, 'Post-processor');
            applyMovedEpisodes(getMovieById(movie.id) ?? movie, moved, downloads);
          }
        } finally {
          movingMovies.delete(movie.id);
        }
        continue;
      }

      // Movies: single-folder (or orphaned direct-file) matching. Shows already
      // returned above via the per-episode path.
      const matchingFolder = folders.find(f => folderMatchesMovie(f, movie, downloads));
      let sourcePath: string;
      let folderLabel: string;
      let isDirectFile = false;

      if (matchingFolder) {
        sourcePath = path.join(downloadPath, matchingFolder);
        folderLabel = matchingFolder;
      } else {
        // Fallback: recursive scan for orphaned direct-download files.
        // (Direct-link plugins skip JD's extract step, so JD never moves the
        // file out of its working dir like `unfertige/<package>/`.)
        const expectedBasenames = new Set<string>();
        for (const dl of downloads) {
          try { expectedBasenames.add(path.basename(new URL(dl.download_url).pathname).toLowerCase()); }
          catch { /* malformed URL — skip */ }
        }
        const orphan = findOrphanedMediaFile(getDownloadFileIndex(), expectedBasenames, movie, downloads);
        if (!orphan) {
          if (movie.status === 'downloading') {
            const releaseNames = downloads.map(d => d.release_name).filter(Boolean);
            logger.debug(`Post-processor: NO folder match for "${movie.title}" (${movie.year}) [${movie.status}] — title normalized: "${normalizeTitle(movie.title)}"${releaseNames.length ? `, releases: ${releaseNames.join(', ')}` : ''} — available folders: ${folders.length > 0 ? folders.slice(0, 10).join(', ') : 'none'}`);
          }
          continue;
        }
        sourcePath = orphan.sourcePath;
        folderLabel = orphan.folderName;
        isDirectFile = true;
        logger.info(`Post-processor: found orphaned media file for "${movie.title}" at ${sourcePath}`);
      }

      // Hold off while JDownloader still has a BUSY package for this title — not
      // finished downloading, or mid-extraction (JD can flag finished=true while
      // its Extraction extension still runs). Moving now would truncate a
      // still-growing file. An errored package blocks too — its output is partial;
      // syncDownloadingStatus removes it and its output. JD unreachable / no matching package → fall
      // through to the on-disk readiness checks below.
      const movieTitleNorm = normalizeTitle(movie.title);
      const movieTitleWords = movieTitleNorm.split(' ').filter(w => w.length > 1);
      const jdBusy = jdReachable && jdPkgList.some(p => {
        const pkgNorm = normalizeTitle(p.name || '');
        const matches = pkgNorm.includes(movieTitleNorm)
          || (movieTitleWords.length > 0 && movieTitleWords.every(w => pkgNorm.includes(w)));
        if (!matches) return false;
        if (jdPackageErrorKind(p) !== null) return true;
        const s = (p.status || '').toLowerCase();
        const extracting = s.includes('extract') || s.includes('entpack');
        return p.finished !== true || extracting;
      });
      if (jdBusy) {
        logger.debug(`${movie.title}: JDownloader package still busy (downloading/extracting) — waiting before move`);
        continue;
      }

      // For direct files: skip the folder-based readiness checks (we already
      // verified file size + extension during the recursive scan).
      if (!isDirectFile) {
        if (!hasMediaFiles(sourcePath)) {
          logger.debug(`${movie.title}: folder found but no media files yet: ${folderLabel}`);
          continue;
        }

        if (isStillExtracting(sourcePath)) {
          logger.debug(`${movie.title}: extraction still in progress (file size unstable): ${folderLabel}`);
          continue;
        }
      }

      const targetPath = resolveLibraryTarget(movie);
      if (!targetPath) {
        logger.warn(`Post-processor: ${movie.title} — matched "${folderLabel}" but movies path not configured`);
        continue;
      }

      await markMovieDownloaded(movie, sourcePath, folderLabel, targetPath, 'Post-processor');
    }
  } catch (error: any) {
    if (!error.message?.includes('not configured')) {
      logger.error(`Post-process check error: ${error.message}`);
    }
  }
}

/**
 * Sync status of 'downloading' movies:
 * - If movie now exists in media server library → mark as 'downloaded'
 * - If JD package no longer exists and movie is in library → mark as 'downloaded'
 */
/**
 * After a JD error, delete what the failed package left in /downloads — once
 * JD no longer holds archives there, nothing can finish it, and a later cycle
 * would take the half-extracted file for a complete one. Folders that still
 * hold archives stay: a fresh download or a manual repair can use them.
 */
async function removePartialOutput(movie: Movie, pkg: JDPackage, errKind: string): Promise<void> {
  try {
    const dlPath = getSetting('paths.downloads');
    const folder = pkg.saveTo ? lastPathSegment(pkg.saveTo) : (pkg.name || '');
    if (!dlPath || !folder) return;
    const root = path.resolve(dlPath);
    const dir = path.resolve(root, folder);
    // Never the downloads root itself (a package saved straight into it) or anything outside it.
    if (path.dirname(dir) !== root) return;
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory() || hasArchiveOrTempFiles(dir)) return;
    await fs.promises.rm(dir, { recursive: true, force: true });
    logger.warn(`Status sync: ${movie.title} — removed partial output "${folder}" after JD ${errKind} error`);
  } catch (err: any) {
    logger.debug(`Status sync: partial-output cleanup failed for ${movie.title}: ${err.message}`);
  }
}

async function syncDownloadingStatus(allMovies: Movie[], downloadsByMovie: Map<number, Download[]>, jd: JdSnapshot): Promise<void> {
  // Check ALL non-downloaded MOVIES (not shows) against media server library
  // Shows are excluded — their status is driven by per-season/episode tracking,
  // not by a simple "exists in library" check (a show with S01 in library still needs S02)
  const libraryProvider = getLibraryProvider();
  const providerName = getLibraryProviderName();
  if (libraryProvider.isConfigured()) {
    const nonDownloadedMovies = allMovies.filter(m => m.status !== 'downloaded' && m.media_type !== 'show');
    for (const movie of nonDownloadedMovies) {
      // An upgrade-in-flight movie is still in the provider (old version) — don't
      // flip it to 'downloaded', that would orphan the [UPGRADE] download.
      if (upgradingMovies.has(movie.id)) continue;
      // Same reasoning for a title under repair: something deliberately reset it
      // to fetch a replacement, and the media server still lists the old copy —
      // it has not rescanned yet. Flipping it back here cancels the repair.
      if (movie.repair === 1) continue;
      try {
        const inLibrary = await libraryProvider.hasMovie(
          movie.imdb_id, movie.tmdb_id, movie.title, movie.year
        );
        if (inLibrary) {
          updateMovieStatus(movie.id, 'downloaded');
          addLogEntry(movie.id, 'already_in_library',
            `${movie.title} found in ${providerName} — marking as downloaded`);
          logger.info(`Statusabgleich: ${movie.title} ist in ${providerName} — als heruntergeladen markiert`);
        }
      } catch (error: any) {
        logger.debug(`Status sync: ${providerName} check failed for ${movie.title}: ${error.message}`);
      }
    }
  }

  const downloadingMovies = allMovies.filter(m => m.status === 'downloading');
  if (downloadingMovies.length === 0) return;

  // Check for stale 'downloading' entries — check BOTH download list AND linkgrabber
  if (jdownloaderService.isConfigured()) {
    try {
      // Shared per-cycle snapshot — no extra relay round-trips here.
      const { dl: dlPackages, lg: lgPackages } = jd;
      // If either query failed we can't tell "package gone" from "JD unreachable" —
      // skip the entire stale-reset pass. Otherwise a JD outage longer than the 1h
      // threshold would reset every downloading movie to pending.
      if (dlPackages === null || lgPackages === null) {
        logger.warn('Status sync: JD unreachable — skipping stale-reset pass for this round');
        return;
      }
      const dlNames = dlPackages.map(p => p.name || '');
      const lgNames = lgPackages.map(p => p.name || '');

      // Surface the "JD writes somewhere dlvault can't see" misconfiguration:
      // a package finished in JD whose output folder isn't in /downloads can
      // never be moved (the move reads the filesystem, not JD's API).
      const ddPath = getSetting('paths.downloads');
      if (ddPath && fs.existsSync(ddPath)) {
        const ddFolders = fs.readdirSync(ddPath, { withFileTypes: true })
          .filter(e => e.isDirectory()).map(e => e.name);
        diagnoseDownloadMountMismatch(dlPackages, ddFolders, ddPath, downloadingMovies, downloadsByMovie);
      }

      for (const movie of downloadingMovies) {
        // Skip movies currently being processed by the scheduler to avoid race conditions
        if (processingMovies.has(movie.id)) continue;

        const inDownloadList = dlNames.some(n => jdPackageMatchesMovie(n, movie));
        const inLinkGrabber = lgNames.some(n => jdPackageMatchesMovie(n, movie));

        // Record the JD sighting before any branch — used by the stale-reset
        // threshold further down so a transient blip in a later sync doesn't
        // false-reset a movie that JD has been confirming for hours.
        if (inDownloadList || inLinkGrabber) {
          markJdSeen(movie.id);
        }

        if (inDownloadList) {
          // Check if the JD package is actually finished (downloaded + extracted)
          const dlPkg = (dlPackages || []).find(p => jdPackageMatchesMovie(p.name || '', movie));
          const pkgFinished = dlPkg?.finished === true;
          const pkgStatus = (dlPkg?.status || '').toLowerCase();
          const pkgExtracting = pkgStatus.includes('extract') || pkgStatus.includes('entpack');

          // Hard failure in JD (extraction error / fatal download error). The bytes
          // may be fully downloaded, so neither the "finished → move" branch nor the
          // offline-links check below catches it — the movie would sit as
          // "downloading" forever while the downloads page shows red "Fehler".
          // A corrupt/incomplete archive won't fix itself, so pull the dead package
          // out of JD, blocklist this release, and reset for a fresh search. Checked
          // BEFORE the move branch so a broken archive is never treated as complete.
          const errKind = dlPkg ? jdPackageErrorKind(dlPkg) : null;
          if (!errKind) clearJdErrorSightings(movie.id);
          if (errKind && !confirmJdError(movie.id)) {
            logger.info(
              `Status sync: ${movie.title} — JD reports "${dlPkg!.status}" (${errKind}); ` +
              `waiting one more cycle before blocklisting in case it is transient`,
            );
            continue;
          }
          if (errKind) {
            try {
              await jdownloaderService.removePackages([dlPkg!.uuid]);
              logger.info(`Status sync: removed failed package "${dlPkg!.name}" (${errKind}) from JD download list`);
            } catch (err: any) {
              logger.debug(`Status sync: failed to remove errored package for ${movie.title}: ${err.message}`);
            }
            await removePartialOutput(movie, dlPkg!, errKind);
            const reason = errKind === 'extraction'
              ? 'auto: Entpackungsfehler in JDownloader (Archiv defekt/unvollständig)'
              : 'auto: Download-Fehler in JDownloader';
            blocklistFailedRelease(movie, downloadsByMovie.get(movie.id) || [], reason);
            if (!settleFailedDownload(movie, 'no_download')) noteDeadRelease(movie);
            addLogEntry(movie.id, errKind === 'extraction' ? 'extraction_failed' : 'jdownloader_error',
              errKind === 'extraction'
                ? `Entpackungsfehler bei "${dlPkg!.name}" — Release geblockt, neue Suche folgt`
                : `Download-Fehler bei "${dlPkg!.name}" — Release geblockt, neue Suche folgt`);
            logger.warn(`Status sync: ${movie.title} — JD ${errKind} error, removed + blocklisted + reset to not_found for retry`);
            clearJdErrorSightings(movie.id);
            continue;
          }

          if (pkgFinished && !pkgExtracting) {
            // Package done in JD — find and move the download folder
            const dlPath = getSetting('paths.downloads');
            const targetPath = resolveLibraryTarget(movie);
            if (dlPath && targetPath && fs.existsSync(dlPath)) {
              const dlFolders = fs.readdirSync(dlPath, { withFileTypes: true })
                .filter(d => d.isDirectory()).map(d => d.name);
              const movieDownloads = downloadsByMovie.get(movie.id) || [];
              let matchingFolder = dlFolders.find(f => folderMatchesMovie(f, movie, movieDownloads));
              if (!matchingFolder && dlPkg?.saveTo) {
                const jdFolder = lastPathSegment(dlPkg.saveTo);
                if (dlFolders.includes(jdFolder)) matchingFolder = jdFolder;
              }
              if (matchingFolder) {
                const sourcePath = path.join(dlPath, matchingFolder);
                if (hasMediaFiles(sourcePath) && !isStillExtracting(sourcePath)) {
                  const moved = await markMovieDownloaded(movie, sourcePath, matchingFolder, targetPath, 'Status sync (JD finished)');
                  if (moved) continue;
                }
              }
            }
          }

          // Check for offline links in download list (incomplete archive)
          if (dlPkg && !pkgFinished) {
            try {
              const dlLinks = await jdownloaderService.getDownloadLinks([dlPkg.uuid]);
              const offlineLinks = dlLinks.filter(l =>
                (l.status || '').toLowerCase().includes('offline')
              );
              if (offlineLinks.length > 0) {
                blocklistFailedRelease(movie, downloadsByMovie.get(movie.id) || [],
                  `auto: ${offlineLinks.length}/${dlLinks.length} links offline at hoster`);
                if (!settleFailedDownload(movie, 'no_download')) noteDeadRelease(movie);
                addLogEntry(movie.id, 'links_offline',
                  `${offlineLinks.length} von ${dlLinks.length} Links offline beim Hoster — Archiv unvollständig`);
                logger.warn(`Statusabgleich: ${movie.title} — ${offlineLinks.length}/${dlLinks.length} Links offline, neue Suche`);
                continue;
              }
            } catch (err: any) {
              logger.debug(`Status sync: failed to check download links for ${movie.title}: ${err.message}`);
            }
          }

          logger.debug(`Status sync: ${movie.title} — still in JD download list${pkgFinished ? ' (finished, waiting for folder)' : ''}, keeping status`);
          continue;
        }

        if (inLinkGrabber) {
          const lgPkg = (lgPackages || []).find(p => jdPackageMatchesMovie(p.name || '', movie));

          if (lgPkg) {
            // Check for offline links via package-level counts, status string, or individual links
            const pkgStatus = (lgPkg.status || '').toLowerCase();
            const hasOfflineByCount = (lgPkg.offlineCount ?? 0) > 0;
            const hasOfflineByStatus = pkgStatus.includes('offline')
              || pkgStatus.includes('unvollständig')
              || pkgStatus.includes('incomplete');
            let hasOfflineByLinks = false;
            let offlineLinkCount = lgPkg.offlineCount ?? 0;
            let totalLinkCount = lgPkg.childCount ?? 0;

            // If package-level doesn't reveal offline, check individual links
            if (!hasOfflineByCount && !hasOfflineByStatus) {
              try {
                const lgLinks = await jdownloaderService.getLinkGrabberLinks([lgPkg.uuid]);
                const offlineLinks = lgLinks.filter(l =>
                  l.availability === 'OFFLINE' ||
                  (l.status || '').toLowerCase().includes('offline')
                );
                if (offlineLinks.length > 0) {
                  hasOfflineByLinks = true;
                  offlineLinkCount = offlineLinks.length;
                  totalLinkCount = lgLinks.length;
                }
              } catch (err: any) {
                logger.debug(`Status sync: failed to check linkgrabber links for ${movie.title}: ${err.message}`);
              }
            }

            if (hasOfflineByCount || hasOfflineByStatus || hasOfflineByLinks) {
              logger.warn(`Status sync: ${movie.title} — ${offlineLinkCount}/${totalLinkCount} links offline, removing from linkgrabber`);

              // Remove dead package from JDownloader linkgrabber
              try {
                await jdownloaderService.removeLinkGrabberPackages([lgPkg.uuid]);
                logger.info(`Status sync: removed dead package "${lgPkg.name}" from JD linkgrabber`);
              } catch (err: any) {
                logger.debug(`Status sync: failed to remove linkgrabber package: ${err.message}`);
              }

              blocklistFailedRelease(movie, downloadsByMovie.get(movie.id) || [],
                `auto: ${offlineLinkCount}/${totalLinkCount} links offline at hoster`);
              if (!settleFailedDownload(movie, 'no_download')) noteDeadRelease(movie);
              addLogEntry(movie.id, 'links_offline',
                `${offlineLinkCount} von ${totalLinkCount} Links offline beim Hoster — Archiv unvollständig, aus JDownloader entfernt`);
              continue;
            }
          }

          // No offline links detected — fall back to stuck threshold
          // But first: double-check the download list with a looser match
          // (JD may have moved links to downloads under a slightly different package name)
          const safeTitle = movie.title.replace(/:/g, ';');
          const titlePrefix = movie.year ? `${safeTitle} (` : safeTitle;
          const alsoDownloading = dlNames.some(n => n.startsWith(titlePrefix));
          if (alsoDownloading) {
            logger.debug(`Status sync: ${movie.title} in linkgrabber but also in download list (name variant) — not stuck`);
          } else {
            const checkedAt = movie.last_checked_at
              ? parseUtcDate(movie.last_checked_at)
              : parseUtcDate(movie.updated_at);
            const stuckThreshold = 2 * 60 * 60 * 1000;
            if (Date.now() - checkedAt > stuckThreshold) {
              updateMovieStatus(movie.id, 'found');
              addLogEntry(movie.id, 'linkgrabber_stuck',
                `Paket hängt seit über 2 Std im JD-Linkgrabber (Captcha?) — neuer Versuch folgt`);
              logger.warn(`Statusabgleich: ${movie.title} hängt im Linkgrabber — wird neu gesendet`);
            }
          }
          continue;
        }

        // Package gone from both JD queues
        // Library folder check is handled by checkLibraryFolders() which runs first.
        // Here we only need to: check download folder, and stale-reset if nothing found.

        // Check if download folder still exists (extraction may be in progress)
        const dlPath = getSetting('paths.downloads');
        if (dlPath && fs.existsSync(dlPath)) {
          const dlFolders = fs.readdirSync(dlPath, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
          const movieDownloads = downloadsByMovie.get(movie.id) || [];
          const matchingDlFolder = dlFolders.find(f => folderMatchesMovie(f, movie, movieDownloads));
          if (matchingDlFolder) {
            const sourcePath = path.join(dlPath, matchingDlFolder);
            if (hasMediaFiles(sourcePath) && !isStillExtracting(sourcePath)) {
              logger.info(`Status sync: ${movie.title} — download folder found (${matchingDlFolder}), keeping status`);
              if (movie.status !== 'downloading') {
                updateMovieStatus(movie.id, 'downloading');
              }
              continue;
            }
          }
        }

        // JD can drop a finished package from its list while the archives are
        // still being unpacked in its working folder ("unfertige/<package>").
        // Resetting then re-sent the very release that was on disk, and the
        // whole film was downloaded a second time.
        if (dlPath && hasRecentWorkingFolder(dlPath, movie)) {
          logger.debug(`Status sync: ${movie.title} — JD package gone but its working folder is still being written to, keeping status`);
          continue;
        }

        // Stale reset: JD package gone, not in library (checkLibraryFolders would have caught it),
        // no download folder — the download was removed (user deleted it in JD, or JD dropped it
        // before completion). Reset to pending so the status stops lying as "downloading".
        // Anchor the threshold to last_jd_check_at (the most recent confirmed JD sighting via
        // markJdSeen, refreshed every ~30 s while the package is alive) and fall back to
        // updated_at for legacy rows. A happily-serving download therefore keeps a fresh
        // baseline and never trips this — only a package that's been continuously absent for
        // the threshold does. JD outages are already excluded (the whole pass is skipped when
        // JD is unreachable), so a short threshold is safe and lets a deletion clear in minutes
        // instead of an hour.
        const seenInJd = !!movie.last_jd_check_at;
        const baseline = parseUtcDate(movie.last_jd_check_at || movie.updated_at);
        // Minimum continuous-absence before assuming the download is really gone.
        // A live download refreshes last_jd_check_at on every sighting (markJdSeen),
        // so it never trips this. Be extra patient when we've NEVER matched the
        // package in JD (name mismatch / linkgrabber↔download-list churn) — a single
        // transient miss must not reset a download that then completes fine (the
        // false-positives observed on several short titles).
        const staleMinutes = seenInJd ? 15 : 45;
        if (Date.now() - baseline > staleMinutes * 60 * 1000) {
          updateMovieStatus(movie.id, 'pending');
          incrementRetryCount(movie.id);
          addLogEntry(movie.id, 'download_stale',
            `JD-Paket seit >${staleMinutes} min weg, nicht in der Library — zurück auf pending`);
          logger.warn(`Statusabgleich: ${movie.title} — kein JD-Paket seit über ${staleMinutes} Min und nicht in der Mediathek, zurück in die Warteschlange`);

          // For SHOWS the aggregate reset above is not enough. A season pack that was
          // sent to JD but never landed leaves the SEASON stuck at 'downloading' (its
          // episodes stay 'pending' until files actually move). On the next pass the
          // scheduler treats a 'downloading' season as a "partial fill", SKIPS the
          // season pack, finds no individual-episode releases, and logs "leaving as
          // downloading" — forever. The show keeps cycling back to pending but the
          // dead season never recovers (Lanternfall S01, 2026-06-07).
          // We only get here when NO JD package matched the show prefix, i.e. none of
          // this show's season packs are alive, so reset every in-flight (downloading/
          // found) season to pending too — the scheduler then re-sends the pack from
          // scratch. 'downloaded' seasons (already in the library) are left untouched.
          if (movie.media_type === 'show') {
            const inFlight = getSeasonsByShowId(movie.id)
              .filter(s => s.status === 'downloading' || s.status === 'found');
            let episodesReset = 0;
            for (const s of inFlight) {
              updateSeasonStatus(s.id, 'pending');
              // Also reset the season's in-flight EPISODES. Individually-sent
              // episodes carry their own 'downloading' status, and the scheduler
              // re-selects only 'pending' ones (getPendingEpisodes) — resetting
              // just the season left them stranded forever, and a later pass
              // (no pending episodes) even flipped the season to a false
              // 'downloaded' with zero files on disk. We only get here when NO
              // JD package matches this show at all, so none of them is alive.
              const stuckEps = getEpisodesBySeasonId(s.id).filter(e => e.status === 'downloading');
              for (const e of stuckEps) updateEpisodeStatus(e.id, 'pending');
              episodesReset += stuckEps.length;
            }
            if (inFlight.length > 0) {
              logger.warn(`Status sync: ${movie.title} — reset ${inFlight.length} stale in-flight season(s) to pending (${inFlight.map(s => `S${String(s.season_number).padStart(2, '0')}`).join(', ')})${episodesReset > 0 ? ` incl. ${episodesReset} stuck episode(s)` : ''}`);
            }
          }
        }
      }
    } catch (error: any) {
      logger.warn(`Status sync: JD check failed: ${error.message}`);
    }
  }

}

/**
 * Check library folders for MOVIES that are already present but not yet marked
 * downloaded (post-restart, external move, status bug). Filesystem-only — no JD
 * or Jellyfin dependency.
 *
 * Shows are intentionally excluded: a series is tracked per season/episode, so a
 * title folder existing in the library does NOT mean the show is complete (it may
 * hold only S01E01). Show completion is driven by applyMovedEpisodes,
 * reconcileEpisodesWithLibrary and reconcileDatabase instead.
 */
function checkLibraryFolders(allMovies: Movie[]): void {
  const moviesPath = getSetting('paths.movies');
  if (!moviesPath) return;

  // Read library folder listing once
  const movieFolders = fs.existsSync(moviesPath) ? fs.readdirSync(moviesPath) : [];
  if (movieFolders.length === 0) return;


  const nonDownloaded = allMovies.filter(m => m.status !== 'downloaded' && m.media_type !== 'show');
  for (const movie of nonDownloaded) {
    if (processingMovies.has(movie.id)) continue;
    if (movingMovies.has(movie.id)) continue;
    // Upgrade in flight → the old file is still in the folder; skip so we don't
    // flip it to 'downloaded' (which marks the download row 'completed' and
    // orphans the [UPGRADE] package in the LinkGrabber).
    if (upgradingMovies.has(movie.id)) continue;
    // A title under repair was deliberately reset to fetch a replacement. Its
    // old copy is still on disk, so this check would find it and undo the repair
    // — observed with 27 seconds between "re-downloading" and "found in library".
    //
    // Quarantining the file is NOT enough to prevent this: matching happens on
    // the normalised entry name, and neither a folder (name unchanged) nor a
    // flat file (".mkv.incomplete" still contains title and year) stops matching.
    if (movie.repair === 1) continue;

    const titleNorm = normalizeTitle(movie.title);
    const titleWords = titleNorm.split(' ').filter(w => w.length > 1);
    if (titleWords.length === 0) continue;

    const yearStr = movie.year ? String(movie.year) : null;

    // Year is required (a movie folder or flat file always carries it) to avoid
    // matching e.g. a remake against the wrong entry.
    const requireYear = !!yearStr;
    // Library names come from our own templates ("Title (Year)") or are release
    // folders ("Title.Year.German…"): either way the part before the year IS the
    // title. Words anywhere marked "Grell" downloaded because "Grell
    // Diaries (2026)" was in the library.
    const found = movieFolders.some(f => {
      if (!nameIsTitle(f, movie.title, requireYear ? movie.year : null)) return false;
      // A folder needs the film itself — not just Sample/ and an .nfo.
      const full = path.join(moviesPath, f);
      try {
        return fs.statSync(full).isDirectory() ? hasFeatureFile(full) : MEDIA_EXT_RE.test(f);
      } catch { return false; }
    });

    if (found) {
      const prevStatus = movie.status;
      updateMovieStatus(movie.id, 'downloaded');
      updateDownloadStatusByMovieId(movie.id, 'completed');
      addLogEntry(movie.id, 'already_in_library',
        `Im Mediathek-Ordner gefunden (vorher ${prevStatus}) — als heruntergeladen markiert`);
      logger.info(`Mediathek-Prüfung: ${movie.title} (${movie.year}) ist vorhanden (vorher ${prevStatus}) — als heruntergeladen markiert`);

      if (prevStatus === 'downloading') {
        sendTelegramNotification('download_complete', movie.title, movie.year ?? 0,
          `Erfolgreich in die Mediathek verschoben!`, movie.imdb_id);
        eventBus.emit('download:complete', { id: movie.id, title: movie.title });
      }
    }
  }
}

/**
 * Move a folder from source to destination.
 * Uses rename if on same filesystem, otherwise falls back to async `mv` shell command
 * to avoid blocking the Node.js event loop for large files (e.g. 25+ GB).
 */
/** Total size in bytes of a file, or recursively of a directory tree. */
export function pathSizeBytes(p: string): number {
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { return 0; }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(p)) {
    total += pathSizeBytes(path.join(p, entry));
  }
  return total;
}

/** Suffix of a library file while it is still being copied in. */
const PART_SUFFIX = '.dlvault-part';

/**
 * After a repair or upgrade lands as "Title (Year).mp4", the replaced
 * "Title (Year).mkv" would stay next to it — the library then lists the title
 * twice. The same when the rename template changed since the old copy came in
 * ("Title (Year).mkv" vs "Title (Year) [imdbid-tt…].mkv"): any film file of
 * the same title and year goes, unless it names a different IMDb id.
 */
export function removeOtherCopies(targetPath: string, fileBase: string, keep: string, logPrefix: string, movie: Movie): void {
  let names: string[];
  try { names = fs.readdirSync(targetPath); } catch { return; }
  for (const n of names) {
    const full = path.join(targetPath, n);
    if (full === keep) continue;
    if (!MEDIA_EXT_RE.test(n)) continue;
    const base = path.parse(n).name;
    if (base !== fileBase) {
      if (!movie.year) continue;
      const tagged = base.match(/\btt\d{5,}\b/i)?.[0];
      if (tagged && tagged.toLowerCase() !== (movie.imdb_id || '').toLowerCase()) continue;
      // A copy imported while the year was unknown has none in its name; its
      // id says which film it is. Without an id it could be a remake — kept.
      if (!nameIsTitle(base, movie.title, movie.year) && !(tagged && nameIsTitle(base.replace(/\s*[[{][^\]}]*\btt\d{5,}[^\]}]*[\]}]/gi, ''), movie.title, null))) continue;
      try { if (!fs.statSync(full).isFile()) continue; } catch { continue; }
    }
    try { fs.unlinkSync(full); logger.info(`${logPrefix}: ${movie.title} — removed the replaced copy "${n}"`); }
    catch (err: any) { logger.warn(`${logPrefix}: ${movie.title} — could not remove the replaced copy "${n}": ${err.message}`); }
  }
}

export async function moveFolder(source: string, dest: string, opts: { isUpgrade?: boolean } = {}): Promise<void> {
  const destParent = path.dirname(dest);
  // The library folder is about to change — the cached listing would miss it.
  invalidateLibraryListing();
  if (!fs.existsSync(destParent)) {
    fs.mkdirSync(destParent, { recursive: true });
  }

  // Determine whether source is a file or a directory — cp syntax differs.
  // statSync throws if source is missing; let the caller see that error.
  const srcStat = fs.statSync(source);
  const isFile = srcStat.isFile();

  // Decide what to do if the destination already exists. Both the atomic
  // rename (POSIX overwrites silently) and the cross-device branch (which
  // rmSync's the dest) would otherwise destroy an existing library file.
  // Overwriting is correct for a genuine quality upgrade — the new file is
  // larger — but a re-download that happens to be smaller/worse (e.g. a
  // reconcile false-negative pulling a lesser release) must NOT clobber the
  // good file already in the library.
  if (fs.existsSync(dest)) {
    let destStat: fs.Stats | null = null;
    try { destStat = fs.statSync(dest); } catch { /* race: treat as absent */ }
    // File size is a proxy for "better", and it is a bad one for an upgrade:
    // 2160p HEVC is routinely SMALLER than the 1080p x264 it replaces. When the
    // caller knows this is a deliberate quality upgrade, the size test would
    // delete the very file we just downloaded, report success, and mark the
    // movie 'downloaded' with nothing changed — so skip it.
    if (isFile && destStat?.isFile() && srcStat.size <= destStat.size && !opts.isUpgrade) {
      logger.info(`Destination already exists and is >= source (${destStat.size} >= ${srcStat.size} bytes) — keeping existing library file, discarding ${path.basename(source)}`);
      try { await fs.promises.rm(source, { force: true }); } catch { /* best effort */ }
      return;
    }
    logger.warn(
      `Overwriting existing destination ${dest} (${destStat?.size ?? '?'} → ${srcStat.size} bytes)` +
      (opts.isUpgrade ? ' — quality upgrade, size guard bypassed' : ''),
    );
  }

  logger.debug(`Moving ${isFile ? 'file' : 'folder'}: ${source} → ${dest}`);

  try {
    // Try atomic rename first (works on same filesystem)
    fs.renameSync(source, dest);
    return;
  } catch (renameErr: any) {
    if (renameErr.code !== 'EXDEV') throw renameErr;
    logger.debug(`rename failed (cross-device), falling back to copy+delete`);
  }

  // Cross-device: copy then delete via Node's built-in recursive copy.
  //
  // Do NOT shell out to `cp -a` / `mv` across devices — they try to preserve
  // ownership, mode and timestamps. On Unraid/Docker the container's UID
  // typically differs from the share's owner, so attribute preservation fails
  // with "Operation not permitted" even when the data itself could be copied.
  // `fs.cp` copies bytes + mode without attempting to chown to the share owner,
  // which is all we need — and unlike `cp` it exists on every platform
  // (the `cp` shell-out was a hard failure on Windows hosts: no such command).
  //
  // Copy under a temporary name next to the destination, verify, then rename
  // into place. In a container /downloads and /movies are separate mounts, so
  // this branch is the NORMAL path, not an edge case. Copying straight onto the
  // final name meant: an upgrade deleted the good library file first, and a full
  // disk or a restart mid-copy left a truncated file under the real name — no
  // old copy, a broken new one, and the media server happily listing it. The
  // rename within one directory is atomic: the old file stays until the new one
  // is complete.
  const tmp = `${dest}${PART_SUFFIX}`;
  try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch { /* stale part from a crash */ }

  // Capture the source byte total *before* the copy — verifying mere existence
  // is not enough: a copy that failed midway (disk full, I/O error) would pass,
  // and the source would then be deleted → silent data loss.
  const srcBytes = pathSizeBytes(source);

  try {
    await fs.promises.cp(source, tmp, { recursive: true, force: true });
    const tmpBytes = pathSizeBytes(tmp);
    if (tmpBytes < srcBytes) {
      throw new Error(`Copy verification failed for ${source}: ${tmpBytes} of ${srcBytes} bytes copied`);
    }
    // A directory cannot be renamed over a non-empty one; a file can (atomically).
    if (!isFile && fs.existsSync(dest)) await fs.promises.rm(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }

  try {
    // async rm — the just-copied source can be a 25+ GB tree; a sync delete
    // would block the event loop for the whole unlink pass.
    await fs.promises.rm(source, { recursive: true, force: true });
  } catch (rmErr: any) {
    logger.warn(`Could not remove source after copy (non-fatal): ${rmErr.message}`);
  }
}

/**
 * Prune stale entries from the folder size cache.
 * Removes entries for folders that no longer exist or are older than 1 hour.
 */
function prunefolderSizeCache(): void {
  const now = Date.now();
  const MAX_AGE = 60 * 60 * 1000; // 1 hour
  for (const [dirPath, entry] of folderSizeCache) {
    if (now - entry.stableSince > MAX_AGE || !fs.existsSync(dirPath)) {
      folderSizeCache.delete(dirPath);
    }
  }
}

/**
 * Run one post-processor cycle: load data once, run both checks.
 */
let cycleRunning = false;

/**
 * Verify a movie/show's files are actually present in the library before allowing cleanup.
 * Scenarios:
 *   A) Move completed normally         → library has files, downloads has leftovers → safe to delete
 *   B) Copy done but cleanup failed    → both have files                             → safe to delete
 *   C) Not yet moved (DB ahead)        → library missing                             → skip, let post-processor move first
 */
/**
 * One listing of a library folder, prepared once: every check below used to
 * read and re-parse the WHOLE folder for every title — films × entries work
 * each hour (3000 films: ~7 s of a blocked event loop on a fast disk, far more
 * on an uncached array share). Kept for a few seconds and dropped whenever
 * dlvault itself changes the folder (moveFolder), so a fresh import is seen.
 */
interface LibraryListing {
  at: number;
  /** Folder mtime when listed — a new or removed entry changes it. */
  mtimeMs: number;
  entries: { name: string; dotless: string; year: string | null }[];
  /** squashed candidate title → indexes into entries (identity rule of nameIsTitle) */
  byTitle: Map<string, number[]>;
}
const LISTING_TTL_MS = 10_000;
const listingCache = new Map<string, LibraryListing>();

export function invalidateLibraryListing(root?: string): void {
  if (root) listingCache.delete(root); else listingCache.clear();
}

const squashTitle = (s: string) => normalizeTitle(s).replace(/ /g, '');

function libraryListing(root: string): LibraryListing | null {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(root).mtimeMs; } catch { return null; }
  const hit = listingCache.get(root);
  if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.at < LISTING_TTL_MS) return hit;
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return null; }
  const entries = names.map(name => ({ name, dotless: normalizeTitle(name.replace(/\./g, ' ')), year: splitTitleYear(name).year }));
  const byTitle = new Map<string, number[]>();
  entries.forEach((e, i) => {
    for (const c of [e.name, ...e.name.split(/\s[-–—]\s/).slice(1)]) {
      const key = squashTitle(splitTitleYear(c).title);
      if (!key) continue;
      const list = byTitle.get(key);
      if (list) { if (!list.includes(i)) list.push(i); } else byTitle.set(key, [i]);
    }
  });
  const listing = { at: Date.now(), mtimeMs, entries, byTitle };
  listingCache.set(root, listing);
  return listing;
}

/**
 * Is the title in the library? Looks in the main library and — when the kids
 * separation is configured — in the matching kids library too. Without that, a
 * film that was (correctly) moved to the kids folder counted as "gone": the
 * problem center listed it as missing and its download leftovers were never
 * cleaned up.
 */
export function isConfirmedInLibrary(
  movie: Movie,
  moviesPath: string | null | undefined,
  seriesPath: string | null | undefined,
): boolean {
  const isShowTitle = movie.media_type === 'show';
  const mainRoot = isShowTitle ? seriesPath : moviesPath;
  if (confirmedInRoot(movie, mainRoot)) return true;
  const kidsRoot = getSetting(isShowTitle ? 'paths.kids_series' : 'paths.kids_movies');
  return !!kidsRoot && kidsRoot !== mainRoot && confirmedInRoot(movie, kidsRoot);
}

function confirmedInRoot(movie: Movie, libRoot: string | null | undefined): boolean {
  if (!libRoot || !fs.existsSync(libRoot)) return false;

  const titleNorm = normalizeTitle(movie.title);
  const titleWords = titleNorm.split(' ').filter(w => w.length > 1);
  if (titleWords.length === 0) return false;

  const listing = libraryListing(libRoot);
  if (!listing) return false;

  // This is the gate that authorises `rm -rf` on a download folder, so the match
  // has to be an identity check, not a hint. Title words alone (the old rule) let
  // "Sandmere (2021)" be confirmed by "/movies/Sandmere Part Two (2024).mkv" and show
  // "24" by any library entry containing "24" — the leftover folder of a
  // DIFFERENT, still-needed title was then deleted.
  //
  // Both library layouts come from our own rename templates: movies carry the
  // year ("{title} ({year})"), series folders are the bare title ("{title}").
  const yearStr = movie.year ? String(movie.year) : null;
  const isShow = movie.media_type === 'show';
  const matching = isShow || !yearStr
    ? listing.entries
      .filter(e => titleWords.every(w => e.dotless.includes(w)) && nameStartsWithShowTitle(e.name, titleNorm))
      .map(e => e.name)
    // Movies: the part before the year must be the title, and the year must
    // agree — "Grell Diaries (2026)" is not "Grell" (2026). Same rule as
    // nameIsTitle, looked up instead of tested against every entry.
    : (listing.byTitle.get(squashTitle(movie.title)) || [])
      .map(i => listing.entries[i])
      .filter(e => e.year === yearStr)
      .map(e => e.name);

  // A flat movie layout keeps the video and its subtitle sidecars side by side
  // ("Title (2014).mkv", "Title (2014)-eng.idx", …), and readdir hands them
  // back in the filesystem's order, not ours — the sidecar can come first.
  // Taking the first name match and then testing THAT for a media extension
  // declared the film missing while the .mkv sat right next to it. Every
  // match gets its turn: one media file, or one folder holding media, is enough.
  for (const entry of matching) {
    const entryPath = path.join(libRoot, entry);
    let stat: fs.Stats;
    try { stat = fs.statSync(entryPath); } catch { continue; }
    if (stat.isFile()) {
      if (MEDIA_EXT_RE.test(entry)) return true;
      continue;
    }
    if (isShow) {
      if (hasMediaFiles(entryPath)) return true;
      continue;
    }
    // A movie folder needs the feature itself. Any media file used to do — a
    // folder holding only Sample/…-sample.mkv (the film long gone) kept the
    // title "in the library" for good, so nothing ever fetched it again.
    if (hasFeatureFile(entryPath)) return true;
  }
  return false;
}

const SAMPLE_RE = /(^|[^a-z])sample([^a-z]|$)/i;

/** A non-sample media file directly in `dir` or one level down (Sample/ dirs skipped). */
function hasFeatureFile(dir: string): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (SAMPLE_RE.test(e.name)) continue;
    if (e.isFile() && MEDIA_EXT_RE.test(e.name)) return true;
    if (e.isDirectory()) {
      try {
        if (fs.readdirSync(path.join(dir, e.name)).some(f => MEDIA_EXT_RE.test(f) && !SAMPLE_RE.test(f))) return true;
      } catch { /* unreadable */ }
    }
  }
  return false;
}

/**
 * Remove leftover download folders/files for movies that are already in the library.
 * Always verifies library presence before deleting — never deletes if not confirmed in library.
 * Handles both season-pack folders (matched by release_name) and per-episode folders (shows).
 */
/**
 * Is there a JD package folder for this title (top level or one below, e.g.
 * "unfertige/Title (2026) - 2160p") that was written to within the last two
 * hours? That is a download still being finished or unpacked, not a lost one.
 */
function hasRecentWorkingFolder(downloadPath: string, movie: Movie): boolean {
  const prefixes = [jdPackagePrefix(movie), jdPackagePrefix({ title: movie.title, year: 0 })];
  const RECENT_MS = 2 * 60 * 60 * 1000;
  const candidates: string[] = [];
  try {
    for (const top of fs.readdirSync(downloadPath, { withFileTypes: true })) {
      if (!top.isDirectory()) continue;
      candidates.push(path.join(downloadPath, top.name));
      try {
        for (const sub of fs.readdirSync(path.join(downloadPath, top.name), { withFileTypes: true })) {
          if (sub.isDirectory()) candidates.push(path.join(downloadPath, top.name, sub.name));
        }
      } catch { /* unreadable */ }
    }
  } catch { return false; }
  for (const dir of candidates) {
    if (!prefixes.some(p => jdPackageMatchesPrefix(path.basename(dir), p))) continue;
    try {
      const newest = Math.max(0, ...fs.readdirSync(dir).map(f => {
        try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; }
      }));
      if (newest > 0 && Date.now() - newest < RECENT_MS) return true;
    } catch { /* vanished */ }
  }
  return false;
}

const ABANDONED_MS = 12 * 60 * 60 * 1000;

/** True when nothing in `dir` (two levels deep) was written to for ABANDONED_MS. */
function isAbandoned(dir: string): boolean {
  let newest = 0;
  const walk = (d: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      try { newest = Math.max(newest, fs.statSync(full).mtimeMs); } catch { /* vanished */ }
      if (e.isDirectory() && depth < 2) walk(full, depth + 1);
    }
  };
  walk(dir, 0);
  return newest > 0 && Date.now() - newest > ABANDONED_MS;
}

async function cleanupOrphanedDownloadFolders(
  allMovies: Movie[],
  downloadsByMovie: Map<number, Download[]>,
  downloadPath: string,
): Promise<void> {
  const moviesPath = getSetting('paths.movies');
  const seriesPath = getSetting('paths.series');

  if (!fs.existsSync(downloadPath)) return;

  // Candidate folders as paths relative to the download root: the top level
  // (where JD extracts to) and one level below it — JD keeps the archives of a
  // package in a working subfolder ("unfertige/<package>"), and that is exactly
  // where failed or cut-short attempts were left behind.
  let entries: string[];
  try {
    const top = fs.readdirSync(downloadPath, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    entries = [...top];
    for (const dir of top) {
      try {
        for (const sub of fs.readdirSync(path.join(downloadPath, dir), { withFileTypes: true })) {
          if (sub.isDirectory()) entries.push(path.join(dir, sub.name));
        }
      } catch { /* unreadable — skip */ }
    }
  } catch { return; }

  const downloadedMovies = allMovies.filter(m => m.status === 'downloaded');

  for (const movie of downloadedMovies) {
    const downloads = downloadsByMovie.get(movie.id) || [];
    const releaseNames = downloads.map(d => d.release_name).filter(Boolean) as string[];

    // JD saves into a folder named after the PACKAGE ("Title (2026) - 2160p",
    // "Title (2023) - S02 - 2160p"), not after the release, so a release-name
    // match alone left every failed or superseded attempt lying in the download
    // directory for good. "(0)" is the package name a title got while its year
    // was still unknown.
    const packagePrefixes = [jdPackagePrefix(movie), jdPackagePrefix({ title: movie.title, year: 0 })];

    // Match folders by release_name (precise), by JD package name, or by
    // title+SxxExx pattern (show episode folders)
    const matchingFolders = entries.filter(rel => {
      const f = path.basename(rel);
      if (releaseNames.some(r => f === r || f.startsWith(r))) return true;
      if (packagePrefixes.some(p => jdPackageMatchesPrefix(f, p))) return true;
      if (movie.media_type === 'show') {
        // Same identity rule as the mover — a substring match here deleted
        // "The.Novice.S05E17…" on behalf of the show "17".
        return /s\d{1,2}e\d{1,3}/i.test(f) && folderMatchesShow(f, movie, downloads);
      }
      return false;
    });

    if (matchingFolders.length === 0) continue;

    // Verify files are confirmed in the library BEFORE touching anything
    if (!isConfirmedInLibrary(movie, moviesPath, seriesPath)) {
      logger.debug(`Cleanup skipped: "${movie.title}" has ${matchingFolders.length} folder(s) in downloads but is not yet confirmed in library — skipping`);
      continue;
    }

    // Library confirmed — safe to remove download copies
    for (const folder of matchingFolders) {
      const folderPath = path.join(downloadPath, folder);
      // Archives without extracted media read as "still extracting" forever; a
      // folder nothing has written to for half a day is an abandoned attempt.
      if (!isAbandoned(folderPath) && isStillExtracting(folderPath)) {
        logger.debug(`Cleanup deferred: "${folder}" still being written to`);
        continue;
      }
      try {
        await fs.promises.rm(folderPath, { recursive: true, force: true });
        folderSizeCache.delete(folderPath);
        logger.info(`Cleaned up downloads: "${movie.title}" — ${folder} (confirmed in library)`);
      } catch (err: any) {
        logger.warn(`Could not clean up ${folder}: ${err.message}`);
      }
    }
  }
}

/**
 * Periodic database reconciliation — cross-checks DB state against filesystem reality.
 *
 * Runs on startup and every hour. Detects and fixes:
 *   1. Stuck 'searching' status (crash mid-search → never retried because not in moviesToProcess)
 *   2. Stuck 'found' status for movies (JD send failed, not caught by retryFailedJDownloaderSends)
 *   3. Show ↔ season aggregate inconsistency (all seasons 'downloaded' but show still wrong)
 *   4. 'downloaded' entries with no matching library folder (warns only — could be intentional)
 */
/**
 * A copy into the library runs under "<name>.dlvault-part" and is renamed when
 * complete. A restart mid-copy leaves the part behind; it is only replaced when
 * the SAME destination is copied again — after a different release (another
 * name) it stayed in the library for good, often 10+ GB. Removes parts older
 * than `maxAgeMs` that no running import writes to. Depth ≤ 3 covers
 * /movies/<file>, /movies/<folder>/<file> and /series/<show>/<season>/<file>.
 */
export function sweepStaleLibraryParts(roots: (string | undefined)[], maxAgeMs = 12 * 60 * 60 * 1000, now = Date.now()): number {
  const active = new Set([...importingMovies.values()].map(i => `${i.dest}${PART_SUFFIX}`));
  let removed = 0;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.endsWith(PART_SUFFIX)) {
        if (active.has(full)) continue;
        try {
          if (now - fs.statSync(full).mtimeMs < maxAgeMs) continue;
          fs.rmSync(full, { recursive: true, force: true });
          removed++;
          logger.warn(`Removed abandoned library copy "${full}" (an import interrupted mid-copy)`);
        } catch { /* best effort */ }
      } else if (e.isDirectory() && depth < 3 && !e.name.endsWith('.trickplay')) {
        walk(full, depth + 1);
      }
    }
  };
  for (const r of new Set(roots.filter((x): x is string => !!x))) walk(r, 1);
  return removed;
}

async function reconcileDatabase(): Promise<void> {
  const moviesPath = getSetting('paths.movies');
  const seriesPath = getSetting('paths.series');
  sweepStaleLibraryParts([moviesPath, seriesPath, getSetting('paths.kids_movies'), getSetting('paths.kids_series')]);

  const allMovies = getAllMovies();
  const now = Date.now();

  // Stale thresholds
  const STALE_SEARCHING_MS = 30 * 60 * 1000;   // 30 min — searches always complete within 5 min
  const STALE_FOUND_MS     = 2 * 60 * 60 * 1000; // 2 h — movie stuck in 'found', JD send never happened

  let fixes = 0;
  let warnings = 0;

  // ── Films whose file is gone: deleted on purpose or lost? ────────────────
  // See libraryRemovals.ts. Watch state is snapshotted while files exist; a
  // watched film that vanishes was deleted deliberately (silent), a run of
  // vanished films is a storage problem (one warning), anything else goes to
  // the problem center. Never downloads on its own.
  try {
    await snapshotWatched(allMovies, getLibraryProvider(), now);
  } catch (err: any) {
    logger.debug(`Library: watch snapshot failed: ${err?.message || err}`);
  }
  const downloadedFilms = allMovies.filter(m => m.media_type === 'movie' && m.status === 'downloaded');
  const goneFilms: Movie[] = [];
  for (const m of downloadedFilms) {
    const present = isConfirmedInLibrary(m, moviesPath, seriesPath);
    if (present && m.removed_at) setRemovedAt(m.id, false);   // back (restored / re-downloaded)
    else if (!present && !m.removed_at) goneFilms.push(m);
    // A film reported as missing that is confirmed again (moved to the kids library, restored by
    // hand): note it, so the problem center drops the old "missing" entry instead of keeping it 30 days.
    if (present && hasRecentActivityEntry(m.id, 'library_missing', 24 * 30) && !hasRecentActivityEntry(m.id, 'library_back', 1)) {
      addLogEntry(m.id, 'library_back', 'Wieder in der Bibliothek bestätigt');
    }
  }
  const rootHealthy = moviesRootHealthy(moviesPath);
  if (goneFilms.length > 0 || (!rootHealthy && downloadedFilms.length > 0)) {
    warnings += applyMissingVerdict(
      classifyMissing(goneFilms, downloadedFilms.length, rootHealthy),
      goneFilms.length,
      text => { sendTelegramSystemAlert(`⚠️ <b>dlvault Bibliothek</b>\n${text}`).catch(() => { /* best effort */ }); },
    );
  }

  for (const movie of allMovies) {
    // ── Check 1: stuck 'searching' ──────────────────────────────────────────
    // 'searching' is not in moviesToProcess so a crash mid-search leaves the movie permanently stuck.
    if (movie.status === 'searching') {
      const age = now - parseUtcDate(movie.updated_at);
      if (age > STALE_SEARCHING_MS) {
        updateMovieStatus(movie.id, 'pending');
        addLogEntry(movie.id, 'reconcile', `Reset from 'searching' to 'pending' (stuck ${Math.round(age / 60000)}min)`);
        logger.info(`Reconcile: "${movie.title}" reset searching → pending (stuck ${Math.round(age / 60000)}min)`);
        fixes++;
      }
      continue;
    }

    // ── Check 2: stuck 'found' for non-show movies ──────────────────────────
    // retryFailedJDownloaderSends handles season-level 'found', but movie-level can slip through.
    if (movie.status === 'found' && movie.media_type !== 'show') {
      const age = now - parseUtcDate(movie.updated_at);
      if (age > STALE_FOUND_MS) {
        updateMovieStatus(movie.id, 'pending');
        addLogEntry(movie.id, 'reconcile', `Reset from 'found' to 'pending' (stuck ${Math.round(age / 3600000)}h)`);
        logger.info(`Reconcile: "${movie.title}" reset found → pending (stuck ${Math.round(age / 3600000)}h)`);
        fixes++;
      }
      continue;
    }

    // ── Check 3: show ↔ season aggregate consistency ────────────────────────
    if (movie.media_type === 'show') {
      // Seasons below the cutoff are deliberately left 'pending' forever; they
      // say nothing about the show's state (same rule as the scheduler).
      const seasons = getSeasonsByShowId(movie.id)
        .filter(s => !movie.season_cutoff || s.season_number >= movie.season_cutoff);
      if (seasons.length === 0) continue;

      if (movie.status === 'downloaded') {
        // A 'pending' season under a downloaded show was reopened on purpose —
        // the Endkontrolle found episodes missing, or the user asked for it.
        // Marking it 'downloaded' (as this check used to) closed it again with
        // no file behind it; the show goes back to 'pending' instead.
        const reopened = seasons.filter(s => s.status === 'pending' && (s.aired_episodes ?? 1) > 0);
        if (reopened.length > 0) {
          updateMovieStatus(movie.id, 'pending');
          logger.info(`Reconcile: "${movie.title}" back to 'pending' — ${reopened.length} season(s) reopened`);
          fixes++;
          continue;
        }
        // Show is 'downloaded' but some seasons have stale non-final states
        const stuck = seasons.filter(s => s.status !== 'downloaded' && s.status !== 'not_found');
        if (stuck.length > 0) {
          for (const s of stuck) updateSeasonStatus(s.id, 'downloaded');
          logger.info(`Reconcile: fixed ${stuck.length} stuck season(s) for "${movie.title}" (show already downloaded)`);
          fixes += stuck.length;
        }
      } else if (movie.status !== 'not_found') {
        // All seasons done but show status not updated
        const allDone = seasons.every(s => s.status === 'downloaded' || s.status === 'not_found');
        const anyDownloaded = seasons.some(s => s.status === 'downloaded');
        if (allDone && anyDownloaded) {
          updateMovieStatus(movie.id, 'downloaded');
          addLogEntry(movie.id, 'reconcile', `Status corrected to 'downloaded' (all seasons done)`);
          logger.info(`Reconcile: "${movie.title}" corrected to 'downloaded' (all seasons done, was ${movie.status})`);
          fixes++;
        }
      }
      continue;
    }

    // ── Check 4: 'downloaded' film on disk — does the media server list it? ──
    // (A film whose file is gone was handled above, before this loop.)
    if (movie.status === 'downloaded') {
      if (movie.removed_at || !isConfirmedInLibrary(movie, moviesPath, seriesPath)) {
        // gone: see the libraryRemovals pass above
      } else if (movie.downloaded_at) {
        // Movies only (shows were handled + `continue`d above). The file IS on disk
        // in /movies, but does the media server actually list
        // it? If not — long after the move, with a working (non-empty) library
        // cache — then this folder probably isn't the one the media server scans
        // (the /movies-mount sibling of the /downloads mismatch), or library
        // scanning is off. Guarded hard (6h settle + populated cache + 24h dedup)
        // so a normal scan delay never trips it. Shows have their own reconcile.
        const provider = getLibraryProvider();
        const settled = now - parseUtcDate(movie.downloaded_at) > 6 * 60 * 60 * 1000;
        if (settled && provider.isConfigured() && provider.getCachedMovieCount() > 0
            && !hasRecentActivityEntry(movie.id, 'library_scan_missing', 24)) {
          const inServer = await provider.hasMovie(movie.imdb_id, movie.tmdb_id, movie.title, movie.year);
          if (!inServer) {
            logger.warn(`Reconcile: "${movie.title}" is on disk in "${moviesPath ?? '/movies'}" but ${getLibraryProviderName()} doesn't list it — check that this folder is the one your media server scans, and that library scanning is enabled.`);
            addLogEntry(movie.id, 'library_scan_missing', `Auf der Platte, aber nicht in ${getLibraryProviderName()} — Mount oder Scan prüfen`);
            warnings++;
          }
        }
      }
    }
  }

  const total = fixes + warnings;
  if (total > 0) {
    logger.info(`Reconcile complete: ${fixes} fix(es), ${warnings} warning(s) across ${allMovies.length} entries`);
  } else {
    logger.debug(`Reconcile complete: database consistent (${allMovies.length} entries checked)`);
  }

  // Consistency watchdog (watchdog.ts): DB, JDownloader, disk and media
  // server checked against each other; findings go to the problem center.
  // Dynamic import — the watchdog reads helpers from this module.
  import('./watchdog')
    .then(w => w.runWatchdog())
    .catch(err => logger.debug(`Watchdog run failed: ${err?.message || err}`));

  // Trim ancient activity_log rows. This used to run only at boot (database
  // init), so a long-running instance outgrew the one capped boot batch
  // (~1-2k new rows/day vs. 5000 pruned per restart). Hourly keeps it flat.
  try {
    const pruned = pruneOldActivityLogs();
    if (pruned > 0) logger.debug(`Reconcile: pruned ${pruned} activity_log row(s) older than 90 days`);
  } catch (err: any) {
    logger.debug(`Reconcile: activity_log prune failed (non-fatal): ${err.message}`);
  }

  rotateExternalLogs();
}

/**
 * Cap log files that no logger owns.
 *
 * winston rotates the files it writes (error.log, combined.log), but anything
 * appended by a sidecar process — the bundled challenge solver writes
 * `flaresolverr.log` with a plain `>>` — has no ceiling at all and grows for as
 * long as the container runs, inside the user's bind-mounted appdata.
 */
function rotateExternalLogs(): void {
  const MAX_BYTES = 10 * 1024 * 1024;
  const logDir = path.join(__dirname, '../../logs');
  // Only files nothing else manages; winston's own files are already capped.
  const MANAGED_BY_WINSTON = /^(error|combined)\d*\.log$/;

  let entries: string[];
  try { entries = fs.readdirSync(logDir); } catch { return; }

  for (const name of entries) {
    if (!name.endsWith('.log') || MANAGED_BY_WINSTON.test(name)) continue;
    const full = path.join(logDir, name);
    try {
      if (fs.statSync(full).size <= MAX_BYTES) continue;
      // Keep one generation, then start fresh. Renaming (rather than truncating)
      // would leave the appending process writing to the rotated inode, so
      // truncate in place instead.
      fs.copyFileSync(full, `${full}.1`);
      fs.truncateSync(full, 0);
      logger.info(`Rotated ${name} (exceeded ${Math.round(MAX_BYTES / 1024 / 1024)} MB)`);
    } catch (err: any) {
      logger.debug(`Log rotation for ${name} failed (non-fatal): ${err.message}`);
    }
  }
}

/**
 * Sweep JD's LinkGrabber for packages JD has finished online-checking and found
 * entirely dead — every child offline, none online. These never autostart and
 * never move to the download list, so they pile up forever: a failed release
 * left behind after its movie was reset/blocklisted no longer maps to any
 * 'downloading' movie, so the per-movie sync in syncDownloadingStatus (which
 * also `continue`s past the linkgrabber branch whenever the movie is ALSO in the
 * download list) never reaches them. This janitor is independent of movie
 * matching, so leftovers get cleaned regardless.
 *
 * Conservative: only removes a package once JD's online check has SETTLED —
 * childCount > 0 AND every child accounted for as offline AND zero online. A
 * package still being checked (counts not yet complete) or holding any online
 * link is left untouched, so a live download is never pulled.
 */
async function cleanupDeadLinkGrabberPackages(lgPackages: JDPackage[] | null): Promise<void> {
  // null = JD unreachable / not polled this idle cycle (can't tell dead from "no info").
  if (!lgPackages || lgPackages.length === 0) return;

  const dead = lgPackages.filter(p => {
    const total = p.childCount ?? 0;
    const online = p.onlineCount ?? 0;
    const offline = p.offlineCount ?? 0;
    return total > 0 && online === 0 && offline >= total;
  });
  if (dead.length === 0) return;

  try {
    await jdownloaderService.removeLinkGrabberPackages(dead.map(p => p.uuid));
    logger.info(`Linkgrabber janitor: removed ${dead.length} dead package(s): ${dead.map(p => p.name).join(', ')}`);
  } catch (err: any) {
    logger.debug(`Linkgrabber janitor: removal failed: ${err.message}`);
  }
}

/**
 * Remove FINISHED packages from JD's download list once their content is
 * confirmed delivered (movie 'downloaded' / season 'downloaded' / episode
 * 'downloaded'). dlvault never cleaned these up, and a lingering finished
 * package silently blocks every later same-named send via the addLinks dedup
 * (which treats any non-dead existing package as "already downloading"):
 *   - Endkontrolle repair re-sends "Title (Jahr) - Sxx - quality" → swallowed,
 *   - weekly season-pack refreshes → swallowed,
 *   - quality upgrades ("… [UPGRADE]" — the tag is stripped in the dedup
 *     prefix) → swallowed,
 * each time burning link resolution (captcha money) for a send that never
 * happens, while the status sync sees the old finished package and reports
 * "finished, waiting for folder" forever.
 *
 * Conservative: only packages that are finished, not extracting, not errored
 * (those are handled by syncDownloadingStatus), that map to a tracked title
 * whose DB state confirms the content reached the library. Removal is
 * list-only — JD's removeLinks does not touch files on disk.
 */
async function cleanupFinishedJdPackages(allMovies: Movie[], packages: JDPackage[] | null): Promise<void> {
  // null = JD unreachable / not polled this idle cycle.
  if (!packages || packages.length === 0) return;

  const toRemove: { uuid: number; name: string }[] = [];
  for (const pkg of packages) {
    if (pkg.finished !== true) continue;
    const status = (pkg.status || '').toLowerCase();
    if (status.includes('extract') || status.includes('entpack')) continue; // still extracting
    if (jdPackageErrorKind(pkg) !== null) continue; // errored — handled by status sync

    const movie = findMovieByJdPackageName(allMovies, pkg.name || '');
    if (!movie) continue; // not ours — never touch packages dlvault didn't create

    if (movie.media_type === 'show') {
      const se = parseSeasonEpisode(pkg.name || '');
      if (se.season === null) continue;
      const season = getSeasonsByShowId(movie.id).find(s => s.season_number === se.season);
      if (!season) continue;
      if (se.episode !== null) {
        const ep = getEpisodesBySeasonId(season.id).find(e => e.episode_number === se.episode);
        if (!ep || ep.status !== 'downloaded') continue;
      } else if (season.status !== 'downloaded') {
        continue;
      }
    } else if (movie.status !== 'downloaded') {
      continue;
    }
    toRemove.push({ uuid: pkg.uuid, name: pkg.name });
  }
  if (toRemove.length === 0) return;

  try {
    await jdownloaderService.removePackages(toRemove.map(p => p.uuid));
    logger.info(`JD janitor: removed ${toRemove.length} finished package(s) already in the library: ${toRemove.map(p => `"${p.name}"`).join(', ')}`);
  } catch (err: any) {
    logger.debug(`JD janitor: removal failed (non-blocking): ${err.message}`);
  }
}

/**
 * Catch-all guard against JD freezing on a modal dialog. JD's worker thread BLOCKS
 * until a dialog is answered, so an unanswered "file already exists" / "duplicate
 * links" prompt stalls the entire download→extract→move pipeline (the exact symptom
 * behind the 2026-06-07 stuck-queue incident). We sweep + auto-answer pending
 * dialogs at the top of every cycle, before any JD state is read. Layer-1 config
 * (IfFileExistsAction=SKIP_FILE) prevents the common one; this catches the rest.
 * Best-effort — never throws, never blocks the cycle.
 */
async function sweepBlockingDialogs(): Promise<void> {
  if (!jdownloaderService.isConfigured()) return;
  try {
    const answered = await jdownloaderService.answerBlockingDialogs();
    if (answered.length === 0) return;
    const summary = answered.map(d => (d.title ? `${d.type}: ${d.title}` : d.type)).join('; ');
    addLogEntry(null, 'jd_dialog_cleared', `JD-Dialog automatisch bestätigt (${answered.length}): ${summary}`);
    logger.warn(`Post-processor: cleared ${answered.length} blocking JD dialog(s): ${summary}`);
    try {
      const { sendTelegramSystemAlert } = await import('./telegram');
      await sendTelegramSystemAlert(
        '⚠️ <b>JDownloader-Dialog automatisch bestätigt</b>\n'
        + `${answered.length} blockierende(r) Dialog(e) hätten den Download-Fortschritt eingefroren und wurden mit dem Standard ("OK") beantwortet:\n`
        + answered.map(d => `• ${d.type}${d.title ? ` — ${d.title}` : ''}`).join('\n')
        + '\nFalls das wiederholt auftritt, bitte prüfen.',
      );
    } catch (err: any) {
      logger.debug(`Failed to send JD-dialog alert to Telegram: ${err.message}`);
    }
  } catch (err: any) {
    logger.debug(`Post-processor: dialog sweep failed (non-blocking): ${err.message}`);
  }
}

async function runPostProcessCycle(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
  // Re-evaluate paths each cycle (they may have been configured after startup)
  const downloadPath = getSetting('paths.downloads');
  const moviesPath = getSetting('paths.movies');
  const seriesPath = getSetting('paths.series');
  const pathsConfigured = !!(downloadPath && (moviesPath || seriesPath));

  // Load all movies once for the entire cycle
  const allMovies = getAllMovies();
  // Batch-load all downloads to avoid N+1 queries in folder matching
  const movieIds = allMovies.map(m => m.id);
  const downloadsByMovie = getDownloadsByMovieIds(movieIds);

  // ── JD relay budget: ONE snapshot per cycle, idle-gated ──────────────────
  // All JD consumers below share this snapshot instead of issuing their own
  // queryPackages calls. When dlvault has nothing in flight AND the last
  // snapshot showed no unfinished JD work, the poll is skipped for
  // JD_IDLE_SKIP_CYCLES cycles — a status flip to 'downloading' (the moment
  // anything is sent to JD) re-opens full-rate polling on the next cycle.
  let jd: JdSnapshot = { dl: null, lg: null };
  if (jdownloaderService.isConfigured()) {
    const hasTrackedActivity = allMovies.some(m => m.status === 'downloading');
    const idle = !hasTrackedActivity && !jdLastSnapshotActive;
    if (idle && jdIdleSkipCount < JD_IDLE_SKIP_CYCLES) {
      jdIdleSkipCount++;
    } else {
      jdIdleSkipCount = 0;
      // Clear any blocking JD modal dialog FIRST — an unanswered dialog
      // freezes JD's worker thread, so nothing below (transitions,
      // completed-download checks) would make progress until it's dismissed.
      await sweepBlockingDialogs();
      jd = await fetchJdSnapshot();
      // Unreachable (null) counts as active so we keep probing for recovery.
      jdLastSnapshotActive = jd.dl === null || jd.lg === null
        || jd.dl.some(p => p.finished !== true)
        || jd.lg.length > 0;
    }
  }

  // First: check library folders for any non-downloaded movies that are already there.
  // This catches files moved externally, post-restart state, or status bugs — no JD dependency.
  checkLibraryFolders(allMovies);

  // Re-read movies after library check (statuses may have changed)
  const updatedMovies = getAllMovies();

  // Emit transition events for JD packages (download finished, extraction start/end).
  // Best-effort; failure is logged at debug and never blocks the rest of the cycle.
  await trackJdPackageTransitions(updatedMovies, jd.dl);

  if (pathsConfigured) {
    await checkCompletedDownloads(updatedMovies, downloadsByMovie, jd.dl);
    await cleanupOrphanedDownloadFolders(updatedMovies, downloadsByMovie, downloadPath!);
  }
  await syncDownloadingStatus(updatedMovies, downloadsByMovie, jd);

  // Clear finished packages whose content is confirmed in the library — a
  // lingering finished package blocks same-named re-sends (repair/upgrade/
  // weekly refresh) via the addLinks dedup. Read movies fresh: the calls above
  // may have just flipped statuses to 'downloaded'.
  await cleanupFinishedJdPackages(getAllMovies(), jd.dl);

  // Sweep dead packages (all links offline) out of JD's linkgrabber — leftovers
  // that no longer map to any tracked movie aren't caught by the per-movie sync.
  await cleanupDeadLinkGrabberPackages(jd.lg);

  // Prune stale cache entries to prevent unbounded growth
  prunefolderSizeCache();
  } finally {
    cycleRunning = false;
  }
}

let postProcessStartupTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let reconcileStartupTimer: NodeJS.Timeout | null = null;

// Most recent cycle promise. The timers fire-and-forget; tests (and a graceful
// shutdown) need a way to await the in-flight cycle — the async fs work inside
// (fs.promises.rm of large trees) outlives the timer tick that started it.
let lastCycle: Promise<void> = Promise.resolve();

/** Test hook: resolves when the most recently started cycle has fully finished. */
export function _awaitCurrentCycle(): Promise<void> {
  return lastCycle;
}

export function startPostProcessor(): void {
  stopPostProcessor();

  // Fresh JD-poll gate per service start — the first cycle always polls.
  jdIdleSkipCount = 0;
  jdLastSnapshotActive = true;

  postProcessTimer = setInterval(() => {
    lastCycle = runPostProcessCycle().catch(err => {
      logger.error('Post-processor cycle error:', err.message);
    });
  }, 30 * 1000);
  postProcessStartupTimer = setTimeout(() => {
    lastCycle = runPostProcessCycle().catch(err => {
      logger.error('Post-processor initial cycle error:', err.message);
    });
  }, 15_000);

  // DB reconciliation: once 60s after startup, then every hour
  reconcileStartupTimer = setTimeout(() => {
    reconcileDatabase().catch(e => logger.warn(`Reconcile failed: ${e.message}`));
  }, 60_000);
  reconcileTimer = setInterval(() => {
    reconcileDatabase().catch(e => logger.warn(`Reconcile failed: ${e.message}`));
  }, 60 * 60 * 1000);

  const downloadPath = getSetting('paths.downloads');
  const moviesPath = getSetting('paths.movies');
  const seriesPath = getSetting('paths.series');
  const pathsConfigured = !!(downloadPath && (moviesPath || seriesPath));

  if (!pathsConfigured) {
    logger.info('Post-processor started (paths not yet configured — will auto-detect when set)');
  } else {
    logger.info('Post-processor started (checking every 30s, reconcile every 1h)');
  }
}

export function stopPostProcessor(): void {
  if (postProcessTimer) {
    clearInterval(postProcessTimer);
    postProcessTimer = null;
  }
  if (postProcessStartupTimer) {
    clearTimeout(postProcessStartupTimer);
    postProcessStartupTimer = null;
  }
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  if (reconcileStartupTimer) {
    clearTimeout(reconcileStartupTimer);
    reconcileStartupTimer = null;
  }
}
