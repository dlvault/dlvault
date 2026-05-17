import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { getSetting } from '../database/index';
import { getAllMovies, updateMovieStatus, incrementRetryCount, Movie } from '../database/services/movies';
import { getDownloadsByMovieIds, updateDownloadStatusByMovieId } from '../database/services/downloads';
import { addBlocklistEntry, isReleaseBlocklisted } from '../database/services/blocklist';
import { addLogEntry } from '../database/services/activityLog';
import { getSeasonsByShowId, updateSeasonStatus } from '../database/services/seasons';
import { markAllEpisodesDownloaded } from '../database/services/episodes';
import { jdownloaderService } from '../jdownloader/index';
import type { JDPackage } from '../jdownloader/index';
import { getLibraryProvider, getLibraryProviderName } from './libraryProvider';
import { traktService } from './trakt';
import { logger } from '../utils/logger';
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
  for (const m of allMovies) {
    const prefix = `${m.title} (${m.year})`;
    if (pkgName.startsWith(prefix)) return m;
  }
  return null;
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
  let packages: JDPackage[];
  try {
    packages = await jdownloaderService.getDownloadPackages();
  } catch (err: any) {
    logger.debug(`Post-processor: trackJdPackageTransitions failed: ${err.message}`);
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
 * Shared helper: move a download folder to the library and update all state.
 * Handles movies and shows (season detection), notifications, trakt, and move-lock.
 * Returns true if the movie was successfully marked as downloaded.
 */
async function markMovieDownloaded(
  movie: Movie, sourcePath: string, folderName: string, targetPath: string, logPrefix: string
): Promise<boolean> {
  if (movingMovies.has(movie.id)) {
    logger.debug(`${logPrefix}: ${movie.title} — move already in progress, skipping`);
    return false;
  }
  movingMovies.add(movie.id);

  // Locate the main media file inside the source folder (or the file itself).
  // Files below the junk threshold are skipped — samples, trailers, affiliate-link videos.
  const minJunkMB = getJunkMinSizeMB();
  const srcStat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
  const mainFile = srcStat?.isFile() ? sourcePath : pickMainMediaFile(sourcePath, minJunkMB);
  if (!mainFile) {
    logger.warn(`${logPrefix}: ${movie.title} — no media file >= ${minJunkMB}MB in ${folderName}, skipping`);
    movingMovies.delete(movie.id);
    return false;
  }
  const ext = path.extname(mainFile);

  let destFile: string;
  let seasonNum: number | null = null;

  const movieDownloads = getDownloadsByMovieIds([movie.id]).get(movie.id) || [];
  const dlQuality = movieDownloads[0]?.quality || '';
  const dlAudio = movieDownloads[0]?.audio || '';

  if (movie.media_type === 'show') {
    // Try parsing S/E from folder name first, then fall back to the file name
    let parsed = parseSeasonEpisode(folderName);
    if (parsed.season === null || parsed.episode === null) {
      const fileParsed = parseSeasonEpisode(path.basename(mainFile));
      parsed = {
        season: parsed.season ?? fileParsed.season,
        episode: parsed.episode ?? fileParsed.episode,
      };
    }
    seasonNum = parsed.season;
    if (parsed.season === null || parsed.episode === null) {
      logger.warn(`${logPrefix}: ${movie.title} — could not parse S/E from "${folderName}" / "${path.basename(mainFile)}", skipping`);
      movingMovies.delete(movie.id);
      return false;
    }

    const seriesFolderTemplate = getSetting('rename.series_folder_template') || '{title}';
    const seriesFileTemplate = getSetting('rename.series_file_template') || '{title} S{season}E{episode}';
    const seriesDir = applyRenameTemplate(seriesFolderTemplate, {
      title: movie.title, year: movie.year, quality: dlQuality, audio: dlAudio,
      season: parsed.season, episode: parsed.episode, release: folderName,
    });
    const fileBase = applyRenameTemplate(seriesFileTemplate, {
      title: movie.title, year: movie.year, quality: dlQuality, audio: dlAudio,
      season: parsed.season, episode: parsed.episode, release: folderName,
    });
    destFile = path.join(targetPath, seriesDir, `${fileBase}${ext}`);
    const parentDir = path.join(targetPath, seriesDir);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
      logger.info(`Created series folder: ${parentDir}`);
    }
  } else {
    const movieFileTemplate = getSetting('rename.movie_file_template') || '{title} ({year})';
    const fileBase = applyRenameTemplate(movieFileTemplate, {
      title: movie.title, year: movie.year, quality: dlQuality, audio: dlAudio, release: folderName,
    });
    destFile = path.join(targetPath, `${fileBase}${ext}`);
  }

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
    if (srcStat?.isDirectory()) {
      try {
        fs.rmSync(sourcePath, { recursive: true, force: true });
        logger.info(`${logPrefix}: removed source folder "${folderName}"`);
      } catch (err: any) {
        logger.warn(`${logPrefix}: could not remove source folder ${folderName}: ${err.message}`);
      }
    }
    updateDownloadStatusByMovieId(movie.id, 'completed');

    if (movie.media_type === 'show') {
      if (seasonNum) {
        const seasons = getSeasonsByShowId(movie.id);
        const season = seasons.find(s => s.season_number === seasonNum);
        if (season) {
          markAllEpisodesDownloaded(season.id, folderName);
          updateSeasonStatus(season.id, 'downloaded');
          logger.info(`${movie.title} S${String(seasonNum).padStart(2, '0')}: moved to library`);
        }
      }
      const allSeasons = getSeasonsByShowId(movie.id);
      const allDone = allSeasons.length > 0 && allSeasons.every(s => s.status === 'downloaded');
      if (allDone) {
        updateMovieStatus(movie.id, 'downloaded');
      } else {
        const hasDownloading = allSeasons.some(s => s.status === 'downloading');
        updateMovieStatus(movie.id, hasDownloading ? 'downloading' : 'pending');
      }
    } else {
      updateMovieStatus(movie.id, 'downloaded');
    }

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
    logger.error(`${logPrefix}: failed to move ${movie.title}: ${error.message}`);
    addLogEntry(movie.id, 'error', `Move failed: ${error.message}`);
    return false;
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

      // For shows: collect ALL matching episode folders/files (season pack → multiple episode folders)
      if (movie.media_type === 'show') {
        const titleNorm = normalizeTitle(movie.title);
        const titleWords = titleNorm.split(' ').filter(w => w.length > 1);

        // Find all episode folders matching this show
        const matchingEpFolders = folders.filter(f => {
          const fNorm = normalizeTitle(f.replace(/\./g, ' '));
          return titleWords.length >= 1 && titleWords.every(w => fNorm.includes(w))
            && /s\d{1,2}e\d{1,3}/i.test(f);
        });

        // Find all episode files matching this show
        const matchingEpFiles = files.filter(f => {
          const fNorm = normalizeTitle(f.replace(/\./g, ' '));
          return titleWords.length >= 1 && titleWords.every(w => fNorm.includes(w))
            && /s\d{1,2}e\d{1,3}/i.test(f);
        });

        // Also check for season-level folder match (original behavior)
        const matchingFolder = folders.find(f => folderMatchesMovie(f, movie, downloads));

        if (matchingEpFolders.length > 0 || matchingEpFiles.length > 0) {
          logger.info(`Post-processor: show "${movie.title}" [${movie.status}] — ${matchingEpFolders.length} ep folders, ${matchingEpFiles.length} ep files found`);
        } else {
          logger.debug(`Post-processor: show "${movie.title}" [${movie.status}] — 0 ep folders, 0 ep files found`);
        }

        if (matchingEpFolders.length > 0 || matchingEpFiles.length > 0) {
          // Group episodes by season, then move each group
          const episodesByseason = new Map<number, string[]>();
          for (const ep of [...matchingEpFolders, ...matchingEpFiles]) {
            const sMatch = ep.match(/s(\d{1,2})e\d{1,3}/i);
            if (sMatch) {
              const sNum = parseInt(sMatch[1], 10);
              if (!episodesByseason.has(sNum)) episodesByseason.set(sNum, []);
              episodesByseason.get(sNum)!.push(ep);
            }
          }

          const targetPath = getSetting('paths.series');
          if (!targetPath) continue;

          const jdStillExtracting = [...jdExtracting].some(pkgName => {
            const pkgNorm = normalizeTitle(pkgName);
            return titleWords.every(w => w.length > 1 && pkgNorm.includes(w));
          });
          if (jdStillExtracting) {
            logger.debug(`${movie.title}: JDownloader still extracting — waiting`);
            continue;
          }

          logger.info(`Post-processor: ${movie.title} — seasons found: ${[...episodesByseason.keys()].map(s => `S${String(s).padStart(2,'0')}(${episodesByseason.get(s)!.length}ep)`).join(', ')}`);
          const minJunkMB = getJunkMinSizeMB();
          for (const [sNum, episodes] of episodesByseason) {
            // Check if all episodes have media files and are stable
            const allReady = episodes.every(ep => {
              const epPath = path.join(downloadPath, ep);
              const isDir = fs.statSync(epPath).isDirectory();
              return isDir ? hasMediaFiles(epPath) && !isStillExtracting(epPath) : true;
            });
            if (!allReady) {
              logger.debug(`${movie.title} S${String(sNum).padStart(2, '0')}: not all episodes ready yet (${episodes.length} found)`);
              continue;
            }

            const seriesFolderTemplate = getSetting('rename.series_folder_template') || '{title}';
            const seriesFileTemplate = getSetting('rename.series_file_template') || '{title} S{season}E{episode}';
            const seriesDir = applyRenameTemplate(seriesFolderTemplate, {
              title: movie.title, year: movie.year, season: sNum, release: episodes[0],
            });
            const seasonDir = path.join(targetPath, seriesDir);
            if (!fs.existsSync(seasonDir)) {
              fs.mkdirSync(seasonDir, { recursive: true });
            }

            logger.info(`Post-processor: ${movie.title} S${String(sNum).padStart(2, '0')} — moving ${episodes.length} episode(s) → ${seasonDir}`);
            let movedCount = 0;
            for (const ep of episodes) {
              const src = path.join(downloadPath, ep);
              const isDir = fs.statSync(src).isDirectory();
              const mainFile = isDir ? pickMainMediaFile(src, minJunkMB) : src;
              if (!mainFile) {
                logger.warn(`${movie.title}: no media file >= ${minJunkMB}MB in "${ep}", skipping`);
                continue;
              }
              // Parse episode number from folder/file name; season already known
              const parsed = parseSeasonEpisode(ep);
              const epNum = parsed.episode
                ?? parseSeasonEpisode(path.basename(mainFile)).episode;
              if (epNum === null || epNum === undefined) {
                logger.warn(`${movie.title}: could not parse episode number from "${ep}", skipping`);
                continue;
              }
              const fileBase = applyRenameTemplate(seriesFileTemplate, {
                title: movie.title, year: movie.year, season: sNum, episode: epNum, release: ep,
              });
              const dest = path.join(seasonDir, `${fileBase}${path.extname(mainFile)}`);
              try {
                const epSizeMB = (() => { try { return Math.round(fs.statSync(mainFile).size / 1024 / 1024); } catch { return 0; } })();
                const epMoveStart = Date.now();
                await moveFolder(mainFile, dest);
                const epDurationSec = Math.max(1, Math.round((Date.now() - epMoveStart) / 1000));
                logger.info(`${movie.title} S${String(sNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}: moved (${epSizeMB} MB in ${epDurationSec}s) → ${dest}`);
                folderSizeCache.delete(src);
                if (isDir) {
                  try { fs.rmSync(src, { recursive: true, force: true }); } catch (e: any) {
                    logger.warn(`Could not remove source folder ${ep}: ${e.message}`);
                  }
                }
                movedCount++;
              } catch (err: any) {
                logger.error(`Failed to move ${ep}: ${err.message}`);
              }
            }

            // Only mark season as downloaded if all episode moves actually succeeded.
            // Otherwise the files remain in /downloads and the post-processor keeps
            // re-scanning them every cycle, spamming logs with the same failure.
            if (movedCount === episodes.length) {
              const seasons = getSeasonsByShowId(movie.id);
              const season = seasons.find(s => s.season_number === sNum);
              if (season) {
                markAllEpisodesDownloaded(season.id, episodes[0]);
                updateSeasonStatus(season.id, 'downloaded');
                addLogEntry(movie.id, 'moved_to_library', `S${String(sNum).padStart(2, '0')}: ${episodes.length} episode(s) moved to library`);
                logger.info(`${movie.title} S${String(sNum).padStart(2, '0')}: ${episodes.length} episode(s) moved`);
              }
              updateDownloadStatusByMovieId(movie.id, 'completed');
            } else {
              logger.warn(`${movie.title} S${String(sNum).padStart(2, '0')}: only ${movedCount}/${episodes.length} episode(s) moved — will retry next cycle`);
            }
          }

          // Update aggregate show status — only notify on actual transition to avoid duplicates
          const allSeasons = getSeasonsByShowId(movie.id);
          const allDone = allSeasons.length > 0 && allSeasons.every(s => s.status === 'downloaded');
          if (allDone) {
            const wasAlreadyDownloaded = movie.status === 'downloaded';
            updateMovieStatus(movie.id, 'downloaded');
            if (!wasAlreadyDownloaded) {
              sendTelegramNotification('download_complete', movie.title, movie.year ?? 0, 'Alle Staffeln heruntergeladen', movie.imdb_id);
            }
          }
          eventBus.emit('movie:updated', { id: movie.id, title: movie.title });
          continue;
        } else if (!matchingFolder) {
          if (movie.status === 'downloading') {
            logger.debug(`Post-processor: NO match for show "${movie.title}" — ${folders.length} folders, ${files.length} files`);
          } else if (movie.status === 'downloaded') {
            // DB inconsistency: show is 'downloaded' but some seasons stuck in downloading/pending.
            // Nothing in download folder → clean up the stale season statuses.
            const stuckSeasons = getSeasonsByShowId(movie.id)
              .filter(s => s.status === 'downloading' || s.status === 'pending');
            if (stuckSeasons.length > 0) {
              for (const s of stuckSeasons) updateSeasonStatus(s.id, 'downloaded');
              logger.info(`Post-processor: fixed ${stuckSeasons.length} stuck season(s) for "${movie.title}" (show is already downloaded)`);
            }
          }
          continue;
        }
        // Fall through to standard folder-based processing for season-level folders
      }

      // Movie or show with season-level folder: standard single-folder matching
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
          if (movie.status === 'downloading' && movie.media_type !== 'show') {
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

      const targetPath = movie.media_type === 'show' ? seriesPath : moviesPath;
      if (!targetPath) {
        logger.warn(`Post-processor: ${movie.title} — matched "${folderLabel}" but no target path configured (media_type=${movie.media_type})`);
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
      const dlNames = (dlPackages || []).map(p => p.name || '');
      const lgNames = (lgPackages || []).map(p => p.name || '');

      for (const movie of downloadingMovies) {
        // Skip movies currently being processed by the scheduler to avoid race conditions
        if (processingMovies.has(movie.id)) continue;

        const packageName = `${movie.title} (${movie.year})`;
        const inDownloadList = dlNames.some(n => n.startsWith(packageName));
        const inLinkGrabber = lgNames.some(n => n.startsWith(packageName));

        if (inDownloadList) {
          // Check if the JD package is actually finished (downloaded + extracted)
          const dlPkg = (dlPackages || []).find(p => (p.name || '').startsWith(packageName));
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
          const lgPkg = (lgPackages || []).find(p => (p.name || '').startsWith(packageName));

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
          const titlePrefix = `${movie.title} (`;
          const alsoDownloading = dlNames.some(n => n.startsWith(titlePrefix));
          if (alsoDownloading) {
            logger.debug(`Status sync: ${movie.title} in linkgrabber but also in download list (name variant) — not stuck`);
          } else {
            const checkedAt = movie.last_checked_at
              ? new Date(movie.last_checked_at).getTime()
              : new Date(movie.updated_at).getTime();
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
        // no download folder — reset to pending after 1 hour
        const updatedAt = new Date(movie.updated_at).getTime();
        const staleThreshold = 60 * 60 * 1000;
        if (Date.now() - updatedAt > staleThreshold) {
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
 * Check library folders for movies that are already downloaded but not yet marked.
 * Runs for ALL non-downloaded movies (pending, searching, found, downloading, not_found)
 * so that no movie slips through regardless of status transitions or restarts.
 * Only checks the filesystem — no JD or Jellyfin dependency.
 */
function checkLibraryFolders(allMovies: Movie[]): void {
  const moviesPath = getSetting('paths.movies');
  const seriesPath = getSetting('paths.series');
  if (!moviesPath && !seriesPath) return;

  // Read library folder listings once
  const movieFolders = moviesPath && fs.existsSync(moviesPath)
    ? fs.readdirSync(moviesPath) : [];
  const seriesFolders = seriesPath && fs.existsSync(seriesPath)
    ? fs.readdirSync(seriesPath) : [];

  if (movieFolders.length === 0 && seriesFolders.length === 0) return;

  // Normalize folder names once for efficient matching
  const movieFoldersNorm = movieFolders.map(f => normalizeTitle(f.replace(/\./g, ' ')));
  const seriesFoldersNorm = seriesFolders.map(f => normalizeTitle(f.replace(/\./g, ' ')));

  const nonDownloaded = allMovies.filter(m => m.status !== 'downloaded');
  for (const movie of nonDownloaded) {
    if (processingMovies.has(movie.id)) continue;
    if (movingMovies.has(movie.id)) continue;

    const titleNorm = normalizeTitle(movie.title);
    const titleWords = titleNorm.split(' ').filter(w => w.length > 1);
    if (titleWords.length === 0) continue;

    const folders = movie.media_type === 'show' ? seriesFoldersNorm : movieFoldersNorm;
    const yearStr = movie.year ? String(movie.year) : null;

    // Year is required for movies (folder or flat file both carry it) but not for
    // shows — in the flat layout the show directory is just {title} with no year.
    const requireYear = movie.media_type !== 'show' && !!yearStr;
    const found = folders.some(fNorm =>
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
async function moveFolder(source: string, dest: string): Promise<void> {
  const destParent = path.dirname(dest);
  if (!fs.existsSync(destParent)) {
    fs.mkdirSync(destParent, { recursive: true });
  }

  // Determine whether source is a file or a directory — cp syntax differs.
  // statSync throws if source is missing; let the caller see that error.
  const isFile = fs.statSync(source).isFile();

  logger.debug(`Moving ${isFile ? 'file' : 'folder'}: ${source} → ${dest}`);

  try {
    // Try atomic rename first (works on same filesystem)
    fs.renameSync(source, dest);
    return;
  } catch (renameErr: any) {
    if (renameErr.code !== 'EXDEV') throw renameErr;
    logger.debug(`rename failed (cross-device), falling back to copy+delete`);
  }

  // Cross-device: copy then delete.
  //
  // Do NOT use `cp -a` / `mv` across devices — they try to preserve ownership,
  // mode and timestamps. On Unraid/Docker the container's UID typically differs
  // from the share's owner, so attribute preservation fails with "Operation not
  // permitted" / "Permission denied" even when the data itself could be copied.
  // Plain `cp` copies the bytes without touching metadata, which is all we need.
  //
  // Pre-remove any stale dest from a previous partial copy so `cp` can recreate it.
  if (fs.existsSync(dest)) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignored */ }
  }

  if (isFile) {
    await execFileAsync('cp', ['-f', source, dest], { timeout: 30 * 60 * 1000 });
  } else {
    await execFileAsync('cp', ['-rf', source + '/.', dest + '/'], { timeout: 30 * 60 * 1000 });
  }

  if (!fs.existsSync(dest)) {
    throw new Error(`Copy verification failed for ${source}`);
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
      const age = now - new Date(movie.updated_at).getTime();
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
      const age = now - new Date(movie.updated_at).getTime();
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

    // ── Check 4: 'downloaded' but not found in library (warn only) ──────────
    if (movie.status === 'downloaded') {
      if (!isConfirmedInLibrary(movie, moviesPath, seriesPath)) {
        logger.warn(`Reconcile: "${movie.title}" (${movie.year}) marked 'downloaded' but not found in library — may have been deleted or moved externally`);
        warnings++;
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
