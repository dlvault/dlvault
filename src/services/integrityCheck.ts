import fs from 'fs';
import path from 'path';
import { getSetting } from '../database/index';
import { getAllMovies, setRepairFlag, type Movie } from '../database/services/movies';
import { getSeasonsByShowId } from '../database/services/seasons';
import { getEpisodesBySeasonId, updateEpisodeStatus } from '../database/services/episodes';
import { addLogEntry, hasRecentActivityEntry } from '../database/services/activityLog';
import { sendTelegramNotification } from './telegram';
import { eventBus } from './eventbus';
import { logger } from '../utils/logger';
import { normalizeTitle, parseSeasonEpisode, resolveLibraryTarget } from './postprocess';
import { audioLanguageTags, audioMatchesLanguage } from '../utils/ffprobe';

const MEDIA_EXT_RE = /\.(mkv|mp4|avi|m4v|wmv|ts)$/i;
const QUARANTINE_SUFFIX = '.incomplete';

// Defaults — overridable via settings (integrity.*). Conservative on purpose: the
// action is destructive-ish (auto re-download), so a legit short episode must not
// be mistaken for a truncated one.
const DEF_FRACTION = 0.5;     // file < 50% of the season median = suspect
const DEF_MIN_MEDIAN_MB = 200; // only judge seasons whose typical episode is substantial
const DEF_MIN_SIBLINGS = 3;    // need enough siblings for a stable median

interface LibEpisode { season: number; episode: number; file: string; size: number; }

export interface IntegrityFlag {
  movieId: number;
  title: string;
  season: number;
  episode: number;
  sizeMB: number;
  medianMB: number;
}

export interface IntegrityResult {
  scannedShows: number;
  flagged: IntegrityFlag[];
  cleaned: number; // stale .incomplete quarantine files removed
}

function numSetting(value: string | undefined, def: number): number {
  const n = value ? parseFloat(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const seKey = (season: number, episode: number): string => `${season}x${episode}`;

/**
 * Walk a show's library folder (plus one level for Season subdirs) collecting
 * episode media files with parsed S/E and byte size. Files that don't parse to
 * an S/E are ignored — we can't compare what we can't place.
 */
function collectShowEpisodes(showDir: string): LibEpisode[] {
  const out: LibEpisode[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(full, depth + 1); continue; }
      if (!MEDIA_EXT_RE.test(e.name)) continue;
      const se = parseSeasonEpisode(e.name);
      if (se.season === null || se.episode === null) continue;
      let size = 0;
      try { size = fs.statSync(full).size; } catch { continue; }
      out.push({ season: se.season, episode: se.episode, file: full, size });
    }
  };
  walk(showDir, 0);
  return out;
}

/**
 * Remove quarantined .incomplete files whose episode now has a healthy real file
 * (a successful re-download landed) — keeps the library tidy without ever
 * deleting a quarantine before its replacement exists.
 */
function cleanupQuarantine(showDir: string, healthyKeys: Set<string>): number {
  let removed = 0;
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(full, depth + 1); continue; }
      if (!e.name.endsWith(QUARANTINE_SUFFIX)) continue;
      const se = parseSeasonEpisode(e.name);
      if (se.season === null || se.episode === null) continue;
      if (!healthyKeys.has(seKey(se.season, se.episode))) continue;
      try {
        fs.rmSync(full, { force: true });
        removed++;
        logger.info(`Integrity: removed stale quarantine "${path.basename(full)}" (healthy replacement present)`);
      } catch { /* best effort */ }
    }
  };
  walk(showDir, 0);
  return removed;
}

/** Find the library folder for a show under its series root (fuzzy title match). */
function findShowDir(root: string, movie: Movie): string | null {
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch { return null; }
  const titleWords = normalizeTitle(movie.title).split(' ').filter(w => w.length > 1);
  if (titleWords.length === 0) return null;
  const match = entries.find(f => {
    const n = normalizeTitle(f.replace(/\./g, ' '));
    return titleWords.every(w => n.includes(w));
  });
  return match ? path.join(root, match) : null;
}

/**
 * Endkontrolle ("final inspection"): scan downloaded shows for episodes whose
 * library file is a strong size outlier versus its season siblings — the
 * fingerprint of a half-written file that an earlier premature move truncated
 * ("plays to half then stops"). Deliberately conservative (needs >= minSiblings
 * episodes, a substantial season median, and a clear sub-fraction gap) so a legit
 * short episode is not mistaken for a broken one.
 *
 * With autoFix (default): quarantine the suspect file (rename → .incomplete, so
 * the library provider stops listing it and libraryReconcile won't re-mark it
 * downloaded), reset its episode to 'pending' (the scheduler re-downloads it on
 * its next pass; moveFolder then writes a fresh, complete file), and notify via
 * Telegram + activity log. Also tidies stale .incomplete files once a healthy
 * replacement is present.
 *
 * Movies are intentionally out of scope: a single file has no per-season baseline
 * to compare against — the move-time JD-finished gate covers them instead.
 */
export function runIntegrityCheck(opts: { autoFix?: boolean } = {}): IntegrityResult {
  const autoFix = opts.autoFix ?? true;
  const result: IntegrityResult = { scannedShows: 0, flagged: [], cleaned: 0 };

  if ((getSetting('integrity.enabled') || 'true') === 'false') return result;

  const fraction = numSetting(getSetting('integrity.outlier_fraction'), DEF_FRACTION);
  const minMedianBytes = numSetting(getSetting('integrity.min_median_mb'), DEF_MIN_MEDIAN_MB) * 1024 * 1024;
  const minSiblings = Math.max(2, Math.floor(numSetting(getSetting('integrity.min_siblings'), DEF_MIN_SIBLINGS)));

  const shows = getAllMovies().filter(m =>
    m.media_type === 'show' && (m.status === 'downloaded' || m.status === 'downloading'));

  for (const movie of shows) {
    const root = resolveLibraryTarget(movie);
    if (!root || !fs.existsSync(root)) continue;
    const showDir = findShowDir(root, movie);
    if (!showDir) continue;
    result.scannedShows++;

    const eps = collectShowEpisodes(showDir);
    if (eps.length === 0) continue;

    const bySeason = new Map<number, LibEpisode[]>();
    for (const e of eps) {
      if (!bySeason.has(e.season)) bySeason.set(e.season, []);
      bySeason.get(e.season)!.push(e);
    }

    const dbSeasons = getSeasonsByShowId(movie.id);
    const healthyKeys = new Set<string>();

    for (const [sNum, seasonEps] of bySeason) {
      if (seasonEps.length < minSiblings) {
        // Not enough siblings to judge — treat all as healthy for cleanup purposes.
        for (const e of seasonEps) healthyKeys.add(seKey(e.season, e.episode));
        continue;
      }
      const med = median(seasonEps.map(e => e.size));
      if (med < minMedianBytes) {
        for (const e of seasonEps) healthyKeys.add(seKey(e.season, e.episode));
        continue;
      }
      const threshold = med * fraction;

      for (const ep of seasonEps) {
        if (ep.size >= threshold) {
          healthyKeys.add(seKey(ep.season, ep.episode));
          continue;
        }
        // Suspect: file far smaller than its siblings → likely truncated.
        const sMM = Math.round(ep.size / 1024 / 1024);
        const medMM = Math.round(med / 1024 / 1024);
        const epLabel = `S${String(sNum).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
        result.flagged.push({ movieId: movie.id, title: movie.title, season: sNum, episode: ep.episode, sizeMB: sMM, medianMB: medMM });
        logger.warn(`Integrity: ${movie.title} ${epLabel} looks incomplete — ${sMM}MB vs season median ${medMM}MB`);

        if (!autoFix) continue;

        // Quarantine the truncated file so the library no longer lists it.
        try {
          fs.renameSync(ep.file, ep.file + QUARANTINE_SUFFIX);
        } catch (err: any) {
          logger.error(`Integrity: failed to quarantine ${epLabel} of ${movie.title}: ${err.message}`);
          continue;
        }

        // Reset the DB episode so the scheduler re-downloads it next pass.
        const dbSeason = dbSeasons.find(s => s.season_number === sNum);
        const dbEp = dbSeason
          ? getEpisodesBySeasonId(dbSeason.id).find(e => e.episode_number === ep.episode)
          : undefined;
        if (dbEp) updateEpisodeStatus(dbEp.id, 'pending');
        // Mark the show "under repair" so the queue shows a Reparatur badge while
        // it re-downloads, not a confusing out-of-nowhere download. Cleared when
        // the show next reaches 'downloaded'.
        setRepairFlag(movie.id, true);

        addLogEntry(movie.id, 'integrity_incomplete',
          `${epLabel} unvollständig (${sMM} MB vs. ${medMM} MB Staffel-Median) — wird neu geladen`);
        sendTelegramNotification('error', movie.title, movie.year ?? 0,
          `Folge ${epLabel} war unvollständig auf dem Server — ich lade sie neu.`, movie.imdb_id)
          .catch(() => { /* best effort */ });
        eventBus.emit('movie:updated', { id: movie.id, title: movie.title });
      }
    }

    result.cleaned += cleanupQuarantine(showDir, healthyKeys);
  }

  if (result.flagged.length > 0 || result.cleaned > 0) {
    logger.info(`Integrity check: ${result.flagged.length} incomplete episode(s) flagged, ${result.cleaned} stale quarantine(s) cleaned across ${result.scannedShows} show(s)`);
  }
  return result;
}

// ── Audio-language verification (opt-in) ─────────────────────────────────────

export interface AudioLanguageResult {
  scanned: number;
  mismatched: { movieId: number; title: string; files: string[] }[];
}

// In-process memo of files already probed, keyed by path → byte size. ffprobe
// reads only the container header (cheap) but re-running it over an unchanged
// library every sync is still wasted work; a size change (re-download) busts
// the entry so a replaced file is re-judged. Cleared on restart (re-probe once
// after a restart is acceptable). Bounded by library size.
const audioProbeMemo = new Map<string, number>();

/** Test helper — drop the per-file probe memo between runs. */
export function _resetAudioProbeMemo(): void {
  audioProbeMemo.clear();
}

/** Media files for a movie title under its library root (flat file or folder). */
function collectMovieFiles(root: string, movie: Movie): string[] {
  const titleWords = normalizeTitle(movie.title).split(' ').filter(w => w.length > 1);
  if (titleWords.length === 0) return [];
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch { return []; }
  const out: string[] = [];
  for (const name of entries) {
    const norm = normalizeTitle(name.replace(/\./g, ' '));
    if (!titleWords.every(w => norm.includes(w))) continue;
    // A movie folder/file always carries the year — require it (when known) so
    // a remake or same-word title isn't probed against the wrong file.
    if (movie.year && !norm.includes(String(movie.year))) continue;
    const full = path.join(root, name);
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isFile()) {
      if (MEDIA_EXT_RE.test(name)) out.push(full);
    } else if (st.isDirectory()) {
      try {
        for (const f of fs.readdirSync(full)) if (MEDIA_EXT_RE.test(f)) out.push(path.join(full, f));
      } catch { /* unreadable — skip */ }
    }
  }
  return out;
}

/**
 * Verify that downloaded titles actually carry an audio track TAGGED in the
 * wanted language (`quality.language`, default german). Opt-in via
 * `integrity.verify_language=true`; off by default.
 *
 * Scope and limits, stated plainly because this is easy to over-trust:
 *  - It reads the audio-stream LANGUAGE TAGS via ffprobe, not the spoken
 *    content. It catches the crude failure "release declared German but ships
 *    no German-tagged audio track at all" (a mislabeled English-only release).
 *  - It does NOT catch a correctly-tagged track whose content is the wrong
 *    language (e.g. a "ger"-tagged stream that actually contains English) —
 *    that needs real speech detection and is out of scope.
 *  - It is WARN-ONLY: a missing tag is lower-confidence than a truncated file
 *    (some legit releases leave tracks untagged), and auto-redownloading could
 *    loop on a source that only has that release. We flag + notify; the user
 *    decides. Untagged audio and ffprobe-unavailable both mean "cannot judge"
 *    and are never flagged.
 *
 * Deduped per title / 24h so a wrong-language season alerts once, not per file.
 * Runs over the existing library, so it also surfaces ALREADY-imported
 * wrong-language titles on the next sync, not just future downloads.
 */
export async function runAudioLanguageCheck(): Promise<AudioLanguageResult> {
  const result: AudioLanguageResult = { scanned: 0, mismatched: [] };
  if (getSetting('integrity.verify_language') !== 'true') return result;

  const wanted = (getSetting('quality.language') || 'german').toLowerCase().trim();
  if (!wanted || wanted === 'any' || wanted === 'all') return result; // no preference → nothing to verify

  const titles = getAllMovies().filter(m => m.status === 'downloaded');
  for (const movie of titles) {
    const root = resolveLibraryTarget(movie);
    if (!root || !fs.existsSync(root)) continue;

    let files: string[];
    if (movie.media_type === 'show') {
      const showDir = findShowDir(root, movie);
      files = showDir ? collectShowEpisodes(showDir).map(e => e.file) : [];
    } else {
      files = collectMovieFiles(root, movie);
    }
    if (files.length === 0) continue;
    result.scanned++;

    const bad: string[] = [];
    for (const file of files) {
      let size = 0;
      try { size = fs.statSync(file).size; } catch { continue; }
      if (audioProbeMemo.get(file) === size) continue; // unchanged — already judged
      const tags = await audioLanguageTags(file);
      if (tags === null) continue;        // ffprobe unavailable / error → cannot judge
      audioProbeMemo.set(file, size);
      if (tags.length === 0) continue;     // audio present but untagged → cannot judge
      if (!audioMatchesLanguage(tags, wanted)) bad.push(file);
    }

    if (bad.length === 0) continue;
    result.mismatched.push({ movieId: movie.id, title: movie.title, files: bad });

    if (hasRecentActivityEntry(movie.id, 'audio_language_mismatch', 24)) continue;
    const langLabel = wanted === 'german' ? 'deutsche' : wanted;
    const names = bad.map(f => path.basename(f));
    addLogEntry(movie.id, 'audio_language_mismatch',
      `${bad.length} Datei(en) ohne ${wanted}-Tonspur (Tag-Prüfung): ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' …' : ''}`);
    sendTelegramNotification('error', movie.title, movie.year ?? 0,
      `Achtung: ${bad.length} Datei(en) scheinen keine ${langLabel} Tonspur zu haben (Tonspur-Tags geprüft). Evtl. falsches Release — bitte prüfen.`,
      movie.imdb_id).catch(() => { /* best effort */ });
    logger.warn(`Audio-language: ${movie.title} — ${bad.length} file(s) carry no ${wanted}-tagged audio track`);
    eventBus.emit('movie:updated', { id: movie.id, title: movie.title });
  }

  if (result.mismatched.length > 0) {
    logger.info(`Audio-language check: ${result.mismatched.length} title(s) lack a ${wanted} audio track across ${result.scanned} scanned`);
  }
  return result;
}
