import fs from 'fs';
import path from 'path';
import { getSetting } from '../database/index';
import { getAllMovies, updateMovieStatus, incrementRetryCount, markJdSeen, Movie } from '../database/services/movies';
import { getDownloadsByMovieIds, updateDownloadStatusByMovieId } from '../database/services/downloads';
import { addBlocklistEntry, isReleaseBlocklisted } from '../database/services/blocklist';
import { addLogEntry, hasRecentActivityEntry } from '../database/services/activityLog';
import { getSeasonsByShowId, updateSeasonStatus } from '../database/services/seasons';
import { markEpisodesDownloaded, getSeasonCompletionStatus } from '../database/services/episodes';
import { jdownloaderService } from '../jdownloader/index';
import type { JDPackage } from '../jdownloader/index';
import { getLibraryProvider, getLibraryProviderName } from './libraryProvider';
import { traktService } from './trakt';
import { logger } from '../utils/logger';
import { parseUtcDate } from '../utils/datetime';
import { sendTelegramNotification } from './telegram';
import { eventBus } from './eventbus';
import { processingMovies } from './scheduler';
import type { Download } from '../database/services/downloads';

let postProcessTimer: NodeJS.Timeout | null = null;

/**
 * Apply a rename template with token replacement.
 * Supported tokens: {title}, {year}, {quality}, {audio}, {season}, {episode}, {release}
 * {season} and {episode} are zero-padded to 2 digits.
 * Sanitizes output for filesystem safety.
 */
export function applyRenameTemplate(
  template: string,
  vars: { title: string; year: number | null; quality?: string; audio?: string; season?: number; episode?: number; release?: string }
): string {
  const sanitizeVar = (v: string): string =>
    v.replace(/[\/\\]/g, ' ').replace(/\.{2,}/g, '.').trim();
  const pad2 = (n: number): string => String(n).padStart(2, '0');

  let result = template
    .replace(/\{title\}/g, sanitizeVar(vars.title))
    .replace(/\{year\}/g, String(vars.year || 'Unknown'))
    .replace(/\{quality\}/g, sanitizeVar(vars.quality || ''))
    .replace(/\{audio\}/g, sanitizeVar(vars.audio || ''))
    .replace(/\{season\}/g, vars.season !== undefined ? pad2(vars.season) : '')
    .replace(/\{episode\}/g, vars.episode !== undefined ? pad2(vars.episode) : '')
    .replace(/\{release\}/g, sanitizeVar(vars.release || ''));

  return result
    .split('/')
    .map(segment => segment.replace(/[<>:"|?*]/g, '').replace(/\.+$/, '').trim())
    .filter(seg => seg && seg !== '.' && seg !== '..')
    .join('/');
}

const MEDIA_EXT_RE = /\.(mkv|mp4|avi|m4v|wmv|ts)$/i;

/**
 * Blocklist the most recent release we sent for a movie so the next scheduler pass
 * skips it and picks the next candidate. Without this, a release with dead hoster
 * links loops forever (source returns it → we pick it → JD marks it offline → repeat).
 */
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
 * Parse S/E numbers from a folder or filename like "Series.S01E03.GERMAN..." or "Scrubs S2E5".
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
 * otherwise titles like "Dune: Part Two" or "The Witch: Part 2" never match
 * their own package and `syncDownloadingStatus` falsely flips them to pending
 * after the 1h staleThreshold.
 */
export function jdPackagePrefix(movie: Pick<Movie, 'title' | 'year'>): string {
  const title = movie.title.replace(/:/g, ';');
  return movie.year != null ? `${title} (${movie.year})` : title;
}

/**
 * Does a JD package name belong to `prefix` (= jdPackagePrefix output)?
 * Requires a token boundary after the prefix so "Alien (1979)" does not match
 * "Aliens (1986) ..." and a bare title does not match a longer title that
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

// Track folder sizes between scans for stable-size detection (works on Windows Docker where mtime is unreliable)
const folderSizeCache = new Map<string, { size: number; stableSince: number }>();

// Move-lock: prevent concurrent move operations on the same movie
const movingMovies = new Set<number>();

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
 * Check if a folder name matches a movie title (fuzzy).
 * Release folders use dots: "Pretty.Lethal.Schoen.Toedlich.2026.GERMAN..."
 * We match against title words and year.
 * Accepts pre-loaded downloads to avoid N+1 queries.
 */
export function folderMatchesMovie(folderName: string, movie: Pick<Movie, 'title' | 'year'>, downloads: Pick<Download, 'release_name'>[]): boolean {
  const normalized = normalizeTitle(folderName.replace(/\./g, ' '));

  // PRIMARY: Match against release names from downloads table.
  // Release folder names are highly specific and deterministic — much safer than title matching.
  // e.g. release "Die.Unschuld.2024.GERMAN.1080p.WEB-DL" → folder "Die.Unschuld.2024.GERMAN.1080p.WEB-DL"
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

  // Short titles MUST have year match to avoid matching "IT" to "ITEM.2026..." etc.
  if (isShortTitle && !yearMatch) return false;

  // All title words must appear in the folder name
  const allWordsMatch = titleWords.every(word => normalized.includes(word));

  // For short titles, also verify title appears as a word boundary (not substring)
  if (isShortTitle && allWordsMatch && yearMatch) {
    const words = normalized.split(' ');
    const titleFound = words.some(w => w === titleNorm);
    return titleFound;
  }

  if (allWordsMatch && yearMatch) return true;

  return false;
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
 */
function getMediaSize(dirPath: string): number {
  let totalSize = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile() && /\.(mkv|mp4|avi|m4v|wmv|ts)$/i.test(entry.name)) {
        try { totalSize += fs.statSync(fullPath).size; } catch {}
      } else if (entry.isDirectory()) {
        try {
          for (const sub of fs.readdirSync(fullPath)) {
            if (/\.(mkv|mp4|avi|m4v|wmv|ts)$/i.test(sub)) {
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
        /\.(part\d+|r\d{2}|rar|zip|7z|[0-9]{3}|rev|extracting|tmp)$/i.test(entry.name)
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
    // Extraction temp files — check recursively for multi-part archives in subfolders
    if (hasArchiveOrTempFiles(dirPath)) {
      logger.debug(`Post-processor: ${path.basename(dirPath)} has archive/temp files — still extracting`);
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
 * Resolve a JD package name (e.g. "The Boys (2019) S01 ...") to a known movie.
 * Matches the same prefix convention the scheduler uses when creating packages.
 */
function findMovieByJdPackageName(allMovies: Movie[], pkgName: string): Movie | null {
  // Pick the most specific (longest) matching prefix so a short title can't
  // shadow a longer one that the package actually belongs to.
  let best: Movie | null = null;
  let bestLen = -1;
  for (const m of allMovies) {
    const prefix = jdPackagePrefix(m);
    if (jdPackageMatchesPrefix(pkgName, prefix) && prefix.length > bestLen) {
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
async function trackJdPackageTransitions(allMovies: Movie[]): Promise<void> {
  if (!jdownloaderService.isConfigured()) return;
  let packages: JDPackage[] | null;
  try {
    packages = await jdownloaderService.getDownloadPackages();
  } catch (err: any) {
    logger.debug(`Post-processor: trackJdPackageTransitions failed: ${err.message}`);
    return;
  }
  // JD unreachable — bail. Without this we'd treat "no response" as "no packages"
  // and incorrectly drop every snapshot from jdPackageState as if JD had cleared them.
  if (packages === null) {
    logger.debug('Post-processor: trackJdPackageTransitions skipped — JD unreachable');
    return;
  }

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
 * Get set of package names currently being extracted in JDownloader.
 * Used to avoid moving folders while JD is still extracting archives.
 */
async function getJdExtractingPackages(): Promise<Set<string>> {
  const extracting = new Set<string>();
  if (!jdownloaderService.isConfigured()) return extracting;
  try {
    const packages = await jdownloaderService.getDownloadPackages();
    if (packages === null) return extracting; // JD unreachable — return empty set, caller treats as "nothing extracting"
    for (const pkg of packages) {
      const status = (pkg.status || '').toLowerCase();
      if (status.includes('extract') || status.includes('entpack')) {
        extracting.add(pkg.name);
        logger.debug(`Post-processor: JD package "${pkg.name}" is extracting — will wait`);
      }
    }
  } catch (err: any) {
    logger.debug(`Post-processor: JD extraction check failed: ${err.message}`);
  }
  return extracting;
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
  movingMovies.add(movie.id);
  try {
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
      logger.warn(`${logPrefix}: ${movie.title} — no media file >= ${minJunkMB}MB in ${folderName}, skipping`);
      return false;
    }
    const ext = path.extname(mainFile);
    const dlQuality = movieDownloads[0]?.quality || '';
    const dlAudio = movieDownloads[0]?.audio || '';
    const movieFileTemplate = getSetting('rename.movie_file_template') || '{title} ({year})';
    const fileBase = applyRenameTemplate(movieFileTemplate, {
      title: movie.title, year: movie.year, quality: dlQuality, audio: dlAudio, release: folderName,
    });
    const destFile = path.join(targetPath, `${fileBase}${ext}`);

    try {
      const moveSizeBytes = (() => { try { return fs.statSync(mainFile).size; } catch { return 0; } })();
      const moveSizeMB = Math.round(moveSizeBytes / 1024 / 1024);
      logger.info(`${logPrefix}: ${movie.title} — moving "${path.basename(mainFile)}" (${moveSizeMB} MB) → ${destFile}`);
      const moveStart = Date.now();
      await moveFolder(mainFile, destFile);
      const moveDurationSec = Math.max(1, Math.round((Date.now() - moveStart) / 1000));
      const moveSpeedMBs = moveSizeMB > 0 ? Math.round(moveSizeMB / moveDurationSec) : 0;
      logger.info(`${logPrefix}: ${movie.title} — move complete (${moveSizeMB} MB in ${moveDurationSec}s${moveSpeedMBs > 0 ? `, ${moveSpeedMBs} MB/s` : ''})`);
      folderSizeCache.delete(sourcePath);

      // Source folder is junk after the main file is gone — drop the rest.
      // Only when the source was a directory (we did not just move a loose file).
      if (srcStat.isDirectory()) {
        try {
          fs.rmSync(sourcePath, { recursive: true, force: true });
          logger.info(`${logPrefix}: removed source folder "${folderName}"`);
        } catch (err: any) {
          logger.warn(`${logPrefix}: could not remove source folder ${folderName}: ${err.message}`);
        }
      }
      updateDownloadStatusByMovieId(movie.id, 'completed');
      updateMovieStatus(movie.id, 'downloaded');
      addLogEntry(movie.id, 'moved_to_library', `Moved to library: ${folderName}`);
      logger.info(`${movie.title} moved to ${destFile}`);
      sendTelegramNotification('download_complete', movie.title, movie.year ?? 0,
        `Erfolgreich in die Bibliothek verschoben!`, movie.imdb_id);
      eventBus.emit('download:complete', { id: movie.id, title: movie.title });

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
      if (!hasRecentActivityEntry(movie.id, 'move_failed', 1)) {
        logger.error(`${logPrefix}: failed to move ${movie.title}: ${error.message}`);
        addLogEntry(movie.id, 'move_failed', `Move to library failed (will retry): ${error.message}`);
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
function findOrphanedMediaFile(
  rootDir: string,
  expectedBasenames: Set<string>,
  movie: Pick<Movie, 'title' | 'year'>,
  downloads: Pick<Download, 'release_name'>[],
  maxDepth = 4,
): { sourcePath: string; folderName: string } | null {
  const minJunkBytes = getJunkMinSizeMB() * 1024 * 1024;
  let best: { sourcePath: string; folderName: string; size: number } | null = null;
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
        const baseLower = e.name.toLowerCase();
        const folderName = path.basename(dir);
        const matchesByName = expectedBasenames.has(baseLower);
        const matchesByFolder = folderMatchesMovie(folderName, movie, downloads);
        if (matchesByName || matchesByFolder) {
          if (!best || stat.size > best.size) {
            best = { sourcePath: full, folderName, size: stat.size };
          }
        }
      }
    }
  }
  return best ? { sourcePath: best.sourcePath, folderName: best.folderName } : null;
}

/**
 * Enumerate media files inside a folder (one level deep) and parse S/E from each
 * file name, falling back to the folder name for the season. This is what lets a
 * real season pack — ONE folder containing many SxxExx files — be moved as
 * individual episodes instead of collapsing to the single largest file (which
 * the old movie-style path did, deleting the rest). Files below the junk
 * threshold are skipped (samples / extras / affiliate junk).
 */
export function enumerateEpisodeFiles(
  dir: string,
  folderName: string,
  minSizeMB: number,
): { file: string; season: number | null; episode: number | null }[] {
  const minBytes = Math.max(0, minSizeMB) * 1024 * 1024;
  const folderSE = parseSeasonEpisode(folderName);
  const out: { file: string; season: number | null; episode: number | null }[] = [];

  const consider = (full: string) => {
    if (!MEDIA_EXT_RE.test(full)) return;
    try { if (fs.statSync(full).size < minBytes) return; } catch { return; }
    const fileSE = parseSeasonEpisode(path.basename(full));
    out.push({
      file: full,
      season: fileSE.season ?? folderSE.season,
      episode: fileSE.episode ?? folderSE.episode,
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

  if (container.isDir && (!hasMediaFiles(container.path) || isStillExtracting(container.path))) {
    logger.debug(`${logPrefix}: "${container.name}" not ready yet (no media / still extracting)`);
    return moved;
  }

  const minJunkMB = getJunkMinSizeMB();
  const folderSE = parseSeasonEpisode(container.name);
  const candidates = container.isDir
    ? enumerateEpisodeFiles(container.path, container.name, minJunkMB)
    : [{ file: container.path, ...parseSeasonEpisode(container.name) }];

  const seriesFolderTemplate = getSetting('rename.series_folder_template') || '{title}';
  const seriesFileTemplate = getSetting('rename.series_file_template') || '{title} S{season}E{episode}';
  const dlQuality = downloads[0]?.quality || '';
  const dlAudio = downloads[0]?.audio || '';

  let planned = 0;
  let done = 0;
  let skippedMedia = 0;
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
    });
    const seasonDir = path.join(targetPath, seriesDir);
    if (!fs.existsSync(seasonDir)) fs.mkdirSync(seasonDir, { recursive: true });
    const fileBase = applyRenameTemplate(seriesFileTemplate, {
      title: movie.title, year: movie.year, quality: dlQuality, audio: dlAudio,
      season, episode, release: container.name,
    });
    const dest = path.join(seasonDir, `${fileBase}${path.extname(c.file)}`);
    try {
      const epSizeMB = (() => { try { return Math.round(fs.statSync(c.file).size / 1024 / 1024); } catch { return 0; } })();
      await moveFolder(c.file, dest);
      logger.info(`${logPrefix}: ${movie.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}: moved (${epSizeMB} MB) → ${dest}`);
      if (!moved.has(season)) moved.set(season, new Set());
      moved.get(season)!.add(episode);
      done++;
    } catch (err: any) {
      logger.error(`${logPrefix}: ${movie.title} — failed to move "${path.basename(c.file)}": ${err.message}`);
    }
  }

  // Remove the source folder only when every planned episode moved AND no media
  // file was left behind unmapped — deleting with skipped media = data loss.
  if (container.isDir && planned > 0 && done === planned && skippedMedia === 0) {
    folderSizeCache.delete(container.path);
    try { fs.rmSync(container.path, { recursive: true, force: true }); }
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

  const seasons = getSeasonsByShowId(movie.id);
  for (const [sNum, epNums] of movedBySeason) {
    const season = seasons.find(s => s.season_number === sNum);
    if (!season) {
      // Season pack for a season Trakt never told us about — no row to attach to.
      // The scheduler/libraryReconcile will create + reconcile it on the next sync.
      logger.warn(`${movie.title} S${String(sNum).padStart(2, '0')}: moved ${epNums.size} episode(s) but season is unknown to DB`);
      continue;
    }
    markEpisodesDownloaded(season.id, [...epNums], downloads[0]?.release_name ?? undefined);
    const completion = getSeasonCompletionStatus(season.id);
    updateSeasonStatus(season.id, completion.allDone ? 'downloaded' : 'downloading');
    addLogEntry(movie.id, 'moved_to_library',
      `S${String(sNum).padStart(2, '0')}: ${epNums.size} episode(s) moved to library${completion.total > 0 ? ` (${completion.downloaded}/${completion.total})` : ''}`);
    logger.info(`${movie.title} S${String(sNum).padStart(2, '0')}: ${epNums.size} episode(s) moved (${completion.downloaded}/${completion.total} done)`);
  }
  updateDownloadStatusByMovieId(movie.id, 'completed');

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

async function checkCompletedDownloads(allMovies: Movie[], downloadsByMovie: Map<number, Download[]>): Promise<void> {
  const downloadPath = getSetting('paths.downloads');
  const moviesPath = getSetting('paths.movies');
  const seriesPath = getSetting('paths.series');

  if (!downloadPath || (!moviesPath && !seriesPath)) return;

  // Include everything except 'not_found' — 'downloaded' items are cheap to skip when no folder
  // is found in downloads, and including them ensures orphaned folders get moved after a restart.
  const moviesToCheck = allMovies.filter(m => m.status !== 'not_found');
  if (moviesToCheck.length === 0) return;

  // Ask JDownloader which packages are still extracting
  const jdExtracting = await getJdExtractingPackages();

  try {
    if (!fs.existsSync(downloadPath)) return;

    const allEntries = fs.readdirSync(downloadPath, { withFileTypes: true });
    const folders = allEntries.filter(d => d.isDirectory()).map(d => d.name);
    const files = allEntries.filter(d => d.isFile() && /\.(mkv|avi|mp4|m4v)$/i.test(d.name)).map(d => d.name);

    logger.debug(`Post-processor: scanning ${folders.length} folders + ${files.length} media files in ${downloadPath}, ${moviesToCheck.length} movies to check`);

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
        const targetPath = seriesPath;
        if (!targetPath) {
          logger.warn(`Post-processor: ${movie.title} is a show but paths.series is not configured`);
          continue;
        }
        const titleWords = normalizeTitle(movie.title).split(' ').filter(w => w.length > 1);
        if (titleWords.length === 0) continue;
        const matchesShowTitle = (name: string): boolean => {
          const n = normalizeTitle(name.replace(/\./g, ' '));
          return titleWords.every(w => n.includes(w));
        };

        // Skip the whole show while JD still extracts any of its packages.
        const jdStillExtracting = [...jdExtracting].some(pkgName => {
          const pkgNorm = normalizeTitle(pkgName);
          return titleWords.every(w => pkgNorm.includes(w));
        });
        if (jdStillExtracting) {
          logger.debug(`${movie.title}: JDownloader still extracting — waiting`);
          continue;
        }

        const EP_RE = /s\d{1,2}\s*e\d{1,3}/i;

        // Source containers belonging to this show.
        const sources: ShowSource[] = [];
        for (const f of files) {
          if (matchesShowTitle(f) && EP_RE.test(f)) {
            sources.push({ path: path.join(downloadPath, f), name: f, isDir: false });
          }
        }
        for (const f of folders) {
          const isEpFolder = matchesShowTitle(f) && EP_RE.test(f);
          const isShowFolder = folderMatchesMovie(f, movie, downloads)
            || (matchesShowTitle(f) && parseSeasonEpisode(f).season !== null);
          if (isEpFolder || isShowFolder) {
            sources.push({ path: path.join(downloadPath, f), name: f, isDir: true });
          }
        }

        if (sources.length === 0) {
          if (movie.status === 'downloaded') {
            // DB inconsistency: show 'downloaded' but some seasons stuck. Nothing
            // in downloads → clean up the stale season statuses.
            const stuckSeasons = getSeasonsByShowId(movie.id)
              .filter(s => s.status === 'downloading' || s.status === 'pending');
            if (stuckSeasons.length > 0) {
              for (const s of stuckSeasons) updateSeasonStatus(s.id, 'downloaded');
              logger.info(`Post-processor: fixed ${stuckSeasons.length} stuck season(s) for "${movie.title}" (show already downloaded)`);
            }
          } else if (movie.status === 'downloading') {
            logger.debug(`Post-processor: NO match for show "${movie.title}" — ${folders.length} folders, ${files.length} files`);
          }
          continue;
        }

        // Move each source container, aggregate the delivered episodes, then
        // commit DB state once (mark only what moved, roll up the show status).
        const movedBySeason = new Map<number, Set<number>>();
        for (const source of sources) {
          const moved = await moveShowContainer(movie, source, downloads, targetPath, 'Post-processor');
          for (const [sNum, eps] of moved) {
            if (!movedBySeason.has(sNum)) movedBySeason.set(sNum, new Set());
            for (const e of eps) movedBySeason.get(sNum)!.add(e);
          }
        }
        applyMovedEpisodes(movie, movedBySeason, downloads);
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
        const orphan = findOrphanedMediaFile(downloadPath, expectedBasenames, movie, downloads);
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

      // Check if JDownloader reports this package as still extracting
      const jdStillExtracting = [...jdExtracting].some(pkgName => {
        const pkgNorm = normalizeTitle(pkgName);
        const titleNorm = normalizeTitle(movie.title);
        return pkgNorm.includes(titleNorm) || titleNorm.split(' ').every(w => w.length > 1 && pkgNorm.includes(w));
      });
      if (jdStillExtracting) {
        logger.debug(`${movie.title}: JDownloader still extracting — waiting`);
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

      const targetPath = moviesPath;
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
async function syncDownloadingStatus(allMovies: Movie[], downloadsByMovie: Map<number, Download[]>): Promise<void> {
  // Check ALL non-downloaded MOVIES (not shows) against media server library
  // Shows are excluded — their status is driven by per-season/episode tracking,
  // not by a simple "exists in library" check (a show with S01 in library still needs S02)
  const libraryProvider = getLibraryProvider();
  const providerName = getLibraryProviderName();
  if (libraryProvider.isConfigured()) {
    const nonDownloadedMovies = allMovies.filter(m => m.status !== 'downloaded' && m.media_type !== 'show');
    for (const movie of nonDownloadedMovies) {
      try {
        const inLibrary = await libraryProvider.hasMovie(
          movie.imdb_id, movie.tmdb_id, movie.title, movie.year
        );
        if (inLibrary) {
          updateMovieStatus(movie.id, 'downloaded');
          addLogEntry(movie.id, 'already_in_library',
            `${movie.title} found in ${providerName} — marking as downloaded`);
          logger.info(`Status sync: ${movie.title} is in ${providerName}, updated to downloaded`);
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
      const [dlPackages, lgPackages] = await Promise.all([
        jdownloaderService.getDownloadPackages(),
        jdownloaderService.getLinkGrabberPackages(),
      ]);
      // If either query failed we can't tell "package gone" from "JD unreachable" —
      // skip the entire stale-reset pass. Otherwise a JD outage longer than the 1h
      // threshold would reset every downloading movie to pending.
      if (dlPackages === null || lgPackages === null) {
        logger.warn('Status sync: JD unreachable — skipping stale-reset pass for this round');
        return;
      }
      const dlNames = dlPackages.map(p => p.name || '');
      const lgNames = lgPackages.map(p => p.name || '');

      for (const movie of downloadingMovies) {
        // Skip movies currently being processed by the scheduler to avoid race conditions
        if (processingMovies.has(movie.id)) continue;

        const packageName = jdPackagePrefix(movie);
        const inDownloadList = dlNames.some(n => jdPackageMatchesPrefix(n, packageName));
        const inLinkGrabber = lgNames.some(n => jdPackageMatchesPrefix(n, packageName));

        // Record the JD sighting before any branch — used by the stale-reset
        // threshold further down so a transient blip in a later sync doesn't
        // false-reset a movie that JD has been confirming for hours.
        if (inDownloadList || inLinkGrabber) {
          markJdSeen(movie.id);
        }

        if (inDownloadList) {
          // Check if the JD package is actually finished (downloaded + extracted)
          const dlPkg = (dlPackages || []).find(p => jdPackageMatchesPrefix(p.name || '', packageName));
          const pkgFinished = dlPkg?.finished === true;
          const pkgStatus = (dlPkg?.status || '').toLowerCase();
          const pkgExtracting = pkgStatus.includes('extract') || pkgStatus.includes('entpack');

          if (pkgFinished && !pkgExtracting) {
            // Package done in JD — find and move the download folder
            const dlPath = getSetting('paths.downloads');
            const targetPath = movie.media_type === 'show' ? getSetting('paths.series') : getSetting('paths.movies');
            if (dlPath && targetPath && fs.existsSync(dlPath)) {
              const dlFolders = fs.readdirSync(dlPath, { withFileTypes: true })
                .filter(d => d.isDirectory()).map(d => d.name);
              const movieDownloads = downloadsByMovie.get(movie.id) || [];
              let matchingFolder = dlFolders.find(f => folderMatchesMovie(f, movie, movieDownloads));
              if (!matchingFolder && dlPkg?.saveTo) {
                const jdFolder = path.basename(dlPkg.saveTo);
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
                updateMovieStatus(movie.id, 'not_found');
                incrementRetryCount(movie.id);
                addLogEntry(movie.id, 'links_offline',
                  `${offlineLinks.length} von ${dlLinks.length} Links offline beim Hoster — Archiv unvollständig`);
                logger.warn(`Status sync: ${movie.title} — ${offlineLinks.length}/${dlLinks.length} links offline in download list, marking as not_found`);
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
          const lgPkg = (lgPackages || []).find(p => jdPackageMatchesPrefix(p.name || '', packageName));

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
              updateMovieStatus(movie.id, 'not_found');
              incrementRetryCount(movie.id);
              addLogEntry(movie.id, 'links_offline',
                `${offlineLinkCount} von ${totalLinkCount} Links offline beim Hoster — Archiv unvollständig, aus JDownloader entfernt`);
              continue;
            }
          }

          // No offline links detected — fall back to stuck threshold
          // But first: double-check the download list with a looser match
          // (JD may have moved links to downloads under a slightly different package name)
          const safeTitle = movie.title.replace(/:/g, ';');
          const titlePrefix = movie.year != null ? `${safeTitle} (` : safeTitle;
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
                `Package stuck in JD linkgrabber for >2h (captcha issue?) — will retry`);
              logger.warn(`Status sync: ${movie.title} stuck in linkgrabber, resetting to found`);
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

        // Stale reset: JD package gone, not in library (checkLibraryFolders would have caught it),
        // no download folder — reset to pending after 1 hour.
        // Anchor the threshold to last_jd_check_at (the most recent confirmed
        // JD sighting) and fall back to updated_at for legacy rows that
        // pre-date the column. Without this, a movie that JD has been happily
        // serving for hours flips to pending the first time JD has a hiccup.
        const baseline = parseUtcDate(movie.last_jd_check_at || movie.updated_at);
        const staleThreshold = 60 * 60 * 1000;
        if (Date.now() - baseline > staleThreshold) {
          updateMovieStatus(movie.id, 'pending');
          incrementRetryCount(movie.id);
          addLogEntry(movie.id, 'download_stale',
            `JD package gone, not in library — resetting to pending for retry`);
          logger.warn(`Status sync: ${movie.title} stale download (no JD package, not in library), reset to pending`);
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

  // Normalize folder names once for efficient matching
  const movieFoldersNorm = movieFolders.map(f => normalizeTitle(f.replace(/\./g, ' ')));

  const nonDownloaded = allMovies.filter(m => m.status !== 'downloaded' && m.media_type !== 'show');
  for (const movie of nonDownloaded) {
    if (processingMovies.has(movie.id)) continue;
    if (movingMovies.has(movie.id)) continue;

    const titleNorm = normalizeTitle(movie.title);
    const titleWords = titleNorm.split(' ').filter(w => w.length > 1);
    if (titleWords.length === 0) continue;

    const yearStr = movie.year ? String(movie.year) : null;

    // Year is required (a movie folder or flat file always carries it) to avoid
    // matching e.g. a remake against the wrong entry.
    const requireYear = !!yearStr;
    const found = movieFoldersNorm.some(fNorm =>
      titleWords.every(w => fNorm.includes(w))
      && (!requireYear || fNorm.includes(yearStr!))
    );

    if (found) {
      const prevStatus = movie.status;
      updateMovieStatus(movie.id, 'downloaded');
      updateDownloadStatusByMovieId(movie.id, 'completed');
      addLogEntry(movie.id, 'already_in_library',
        `Found in library folder (was ${prevStatus}) — marking as downloaded`);
      logger.info(`Library check: ${movie.title} (${movie.year}) found in library (was ${prevStatus}), updated to downloaded`);

      if (prevStatus === 'downloading') {
        sendTelegramNotification('download_complete', movie.title, movie.year ?? 0,
          `Erfolgreich in die Bibliothek verschoben!`, movie.imdb_id);
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

async function moveFolder(source: string, dest: string): Promise<void> {
  const destParent = path.dirname(dest);
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
    if (isFile && destStat?.isFile() && srcStat.size <= destStat.size) {
      logger.info(`Destination already exists and is >= source (${destStat.size} >= ${srcStat.size} bytes) — keeping existing library file, discarding ${path.basename(source)}`);
      try { fs.rmSync(source, { force: true }); } catch { /* best effort */ }
      return;
    }
    logger.warn(`Overwriting existing destination ${dest} (${destStat?.size ?? '?'} → ${srcStat.size} bytes)`);
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
  // Pre-remove any stale dest from a previous partial copy so the copy is clean.
  if (fs.existsSync(dest)) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignored */ }
  }

  // Capture the source byte total *before* the copy — verifying mere existence
  // of the dest is not enough: a copy that created the dest then failed midway
  // (disk full, I/O error) would pass an existsSync check, and the source would
  // then be deleted → silent data loss. Compare total bytes instead.
  const srcBytes = pathSizeBytes(source);

  await fs.promises.cp(source, dest, { recursive: true, force: true });

  const destBytes = pathSizeBytes(dest);
  if (destBytes < srcBytes) {
    throw new Error(`Copy verification failed for ${source}: ${destBytes} of ${srcBytes} bytes at dest`);
  }

  try {
    fs.rmSync(source, { recursive: true, force: true });
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
function isConfirmedInLibrary(
  movie: Movie,
  moviesPath: string | null | undefined,
  seriesPath: string | null | undefined,
): boolean {
  const libRoot = movie.media_type === 'show' ? seriesPath : moviesPath;
  if (!libRoot || !fs.existsSync(libRoot)) return false;

  const titleNorm = normalizeTitle(movie.title);
  const titleWords = titleNorm.split(' ').filter(w => w.length > 1);
  if (titleWords.length === 0) return false;

  let libFolders: string[];
  try { libFolders = fs.readdirSync(libRoot); } catch { return false; }

  const matchingEntry = libFolders.find(f => {
    const fNorm = normalizeTitle(f.replace(/\./g, ' '));
    return titleWords.every(w => fNorm.includes(w));
  });
  if (!matchingEntry) return false;

  // Match may be a media file directly (flat movie layout) or a folder.
  const entryPath = path.join(libRoot, matchingEntry);
  try {
    const stat = fs.statSync(entryPath);
    if (stat.isFile()) return MEDIA_EXT_RE.test(matchingEntry);
  } catch { return false; }
  return hasMediaFiles(entryPath);
}

/**
 * Remove leftover download folders/files for movies that are already in the library.
 * Always verifies library presence before deleting — never deletes if not confirmed in library.
 * Handles both season-pack folders (matched by release_name) and per-episode folders (shows).
 */
function cleanupOrphanedDownloadFolders(
  allMovies: Movie[],
  downloadsByMovie: Map<number, Download[]>,
  downloadPath: string,
): void {
  const moviesPath = getSetting('paths.movies');
  const seriesPath = getSetting('paths.series');

  if (!fs.existsSync(downloadPath)) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(downloadPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return; }

  const downloadedMovies = allMovies.filter(m => m.status === 'downloaded');

  for (const movie of downloadedMovies) {
    const downloads = downloadsByMovie.get(movie.id) || [];
    const releaseNames = downloads.map(d => d.release_name).filter(Boolean) as string[];

    // Match folders by release_name (precise) or by title+SxxExx pattern (show episode folders)
    const matchingFolders = entries.filter(f => {
      if (releaseNames.some(r => f === r || f.startsWith(r))) return true;
      if (movie.media_type === 'show') {
        const fNorm = normalizeTitle(f.replace(/\./g, ' '));
        const titleNorm = normalizeTitle(movie.title);
        const titleWords = titleNorm.split(' ').filter(w => w.length > 1);
        return titleWords.length >= 1
          && titleWords.every(w => fNorm.includes(w))
          && /s\d{1,2}e\d{1,3}/i.test(f);
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
      if (isStillExtracting(folderPath)) {
        logger.debug(`Cleanup deferred: "${folder}" still being written to`);
        continue;
      }
      try {
        fs.rmSync(folderPath, { recursive: true, force: true });
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
function reconcileDatabase(): void {
  const moviesPath = getSetting('paths.movies');
  const seriesPath = getSetting('paths.series');

  const allMovies = getAllMovies();
  const now = Date.now();

  // Stale thresholds
  const STALE_SEARCHING_MS = 30 * 60 * 1000;   // 30 min — searches always complete within 5 min
  const STALE_FOUND_MS     = 2 * 60 * 60 * 1000; // 2 h — movie stuck in 'found', JD send never happened

  let fixes = 0;
  let warnings = 0;

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
      const seasons = getSeasonsByShowId(movie.id);
      if (seasons.length === 0) continue;

      if (movie.status === 'downloaded') {
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

    // ── Check 4: 'downloaded' but not found in library ──────────────────────
    // The user may have deleted the file intentionally (watched and done) or
    // because of quality issues — we can't tell which, so we don't auto-act.
    // Status stays 'downloaded' so the watchlist sync won't re-fetch; user
    // decides via UI. To avoid hourly log spam we record the fact once and
    // remind at most once per 24h while it stays missing.
    if (movie.status === 'downloaded') {
      if (!isConfirmedInLibrary(movie, moviesPath, seriesPath)) {
        if (!hasRecentActivityEntry(movie.id, 'library_missing', 24)) {
          logger.info(`Reconcile: "${movie.title}" (${movie.year}) marked 'downloaded' but not found in library — likely deleted externally; not auto-redownloading`);
          addLogEntry(movie.id, 'library_missing', `File missing from library (status remains 'downloaded')`);
          warnings++;
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

  // First: check library folders for any non-downloaded movies that are already there.
  // This catches files moved externally, post-restart state, or status bugs — no JD dependency.
  checkLibraryFolders(allMovies);

  // Re-read movies after library check (statuses may have changed)
  const updatedMovies = getAllMovies();

  // Emit transition events for JD packages (download finished, extraction start/end).
  // Best-effort; failure is logged at debug and never blocks the rest of the cycle.
  await trackJdPackageTransitions(updatedMovies);

  if (pathsConfigured) {
    await checkCompletedDownloads(updatedMovies, downloadsByMovie);
    cleanupOrphanedDownloadFolders(updatedMovies, downloadsByMovie, downloadPath!);
  }
  await syncDownloadingStatus(updatedMovies, downloadsByMovie);

  // Prune stale cache entries to prevent unbounded growth
  prunefolderSizeCache();
  } finally {
    cycleRunning = false;
  }
}

let postProcessStartupTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let reconcileStartupTimer: NodeJS.Timeout | null = null;

export function startPostProcessor(): void {
  stopPostProcessor();

  postProcessTimer = setInterval(() => {
    runPostProcessCycle().catch(err => {
      logger.error('Post-processor cycle error:', err.message);
    });
  }, 30 * 1000);
  postProcessStartupTimer = setTimeout(() => {
    runPostProcessCycle().catch(err => {
      logger.error('Post-processor initial cycle error:', err.message);
    });
  }, 15_000);

  // DB reconciliation: once 60s after startup, then every hour
  reconcileStartupTimer = setTimeout(() => {
    reconcileDatabase();
  }, 60_000);
  reconcileTimer = setInterval(() => {
    reconcileDatabase();
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
