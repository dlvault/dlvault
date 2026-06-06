import fs from 'fs';
import path from 'path';
import { getSetting } from '../database/index';
import { getAllMovies, setRepairFlag, updateMovieStatus, type Movie } from '../database/services/movies';
import { getSeasonsByShowId, updateSeasonStatus } from '../database/services/seasons';
import { getEpisodesBySeasonId, updateEpisodeStatus } from '../database/services/episodes';
import { addLogEntry, hasRecentActivityEntry } from '../database/services/activityLog';
import { loadCheckedFiles, markFileChecked, pruneCheckedFiles } from '../database/services/fileChecks';
import { sendTelegramNotification } from './telegram';
import { eventBus } from './eventbus';
import { logger } from '../utils/logger';
import { normalizeTitle, nameStartsWithShowTitle, nameIsTitle, parseSeasonEpisode, resolveLibraryTarget } from './postprocess';
import { audioLanguageTags, audioMatchesLanguage, mediaDurationSeconds, lastVideoPacketSeconds, lastVideoPacketSecondsFullScan } from '../utils/ffprobe';
import { truncationVerdict } from './importCheck';

const MEDIA_EXT_RE = /\.(mkv|mp4|avi|m4v|wmv|ts)$/i;
const QUARANTINE_SUFFIX = '.incomplete';

/**
 * Largest share of a season that may fall below the size threshold and still be
 * read as "truncated files". A premature move truncates one file at a time, so
 * real damage is always a small minority. Once a third or more of a season is
 * "too small", the season simply isn't uniformly encoded and the median-based
 * test is measuring quality, not completeness.
 */
const MAX_OUTLIER_SHARE = 1 / 3;

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

export interface MissingEpisodesFlag {
  movieId: number;
  title: string;
  season: number;
  present: number;
  aired: number;
}

export interface IntegrityResult {
  scannedShows: number;
  flagged: IntegrityFlag[];
  missing: MissingEpisodesFlag[];
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

export const seKey = (season: number, episode: number): string => `${season}x${episode}`;

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

/**
 * Find the library folder for a show under its series root.
 *
 * Exact title match (plus an optional year/country qualifier), NOT a substring
 * test: this path drives quarantining and status resets, so picking up show
 * "Dark Meridian"'s folder for show "Dark" would rename another series' episodes
 * to `.incomplete` and reset the wrong title to `pending`.
 */
function findShowDir(root: string, movie: Movie): string | null {
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch { return null; }
  const titleNorm = normalizeTitle(movie.title);
  if (!titleNorm) return null;
  const match = entries.find(f => nameStartsWithShowTitle(f, titleNorm));
  return match ? path.join(root, match) : null;
}

/**
 * Episodes of a show that physically sit in its library folder, as "s:e" keys —
 * or null when the folder cannot be found (layout dlvault does not see).
 */
export function libraryEpisodesOnDisk(movie: Movie): Set<string> | null {
  const root = resolveLibraryTarget(movie);
  if (!root || !fs.existsSync(root)) return null;
  const showDir = findShowDir(root, movie);
  if (!showDir) return null;
  return new Set(collectShowEpisodes(showDir).map(e => seKey(e.season, e.episode)));
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
  const result: IntegrityResult = { scannedShows: 0, flagged: [], missing: [], cleaned: 0 };

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

      // "Outlier = truncated" only holds when the small files are a MINORITY
      // against a uniform majority. A mixed-quality season (720p rips sitting
      // next to 1080p ones, 3-4× smaller by design) produces a bimodal split
      // where a large share of the season falls under the threshold — there the
      // size signal says nothing about truncation, and quarantining renames
      // perfectly good episodes to `.incomplete`, hiding them from Plex/Jellyfin
      // and queueing re-downloads that may find nothing.
      const belowCount = seasonEps.filter(e => e.size < threshold).length;
      if (belowCount / seasonEps.length > MAX_OUTLIER_SHARE) {
        logger.debug(
          `Integrity: ${movie.title} S${String(sNum).padStart(2, '0')} has ${belowCount}/${seasonEps.length} episodes ` +
          `below the median-based threshold — that is a quality split, not truncation; skipping season`,
        );
        for (const e of seasonEps) healthyKeys.add(seKey(e.season, e.episode));
        continue;
      }

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
        // Reopen season and show, or the post-processor closes the season again
        // and the quarantined episode is never fetched (Walter Boys, 2026-10).
        if (dbSeason && dbSeason.status === 'downloaded') updateSeasonStatus(dbSeason.id, 'pending');
        updateMovieStatus(movie.id, 'pending');
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

    // A season closed as 'downloaded' with fewer library episodes than have
    // aired: a partial pack or an extraction cut short was taken for complete.
    // The size test above cannot see this — a missing file has no size.
    for (const dbSeason of dbSeasons) {
      const aired = dbSeason.aired_episodes || 0;
      if (dbSeason.status !== 'downloaded' || aired === 0) continue;
      // Below the "from season N" cutoff the user wants nothing — reopening
      // such a season would download seasons they excluded.
      if (movie.season_cutoff && dbSeason.season_number < movie.season_cutoff) continue;
      const present = new Set((bySeason.get(dbSeason.season_number) || []).map(e => e.episode)).size;
      if (present >= aired) continue;
      const sLabel = `S${String(dbSeason.season_number).padStart(2, '0')}`;
      result.missing.push({ movieId: movie.id, title: movie.title, season: dbSeason.season_number, present, aired });
      logger.warn(`Integrity: ${movie.title} ${sLabel} is marked downloaded but only ${present} of ${aired} aired episodes are in the library`);
      if (!autoFix) continue;
      // At most once a week per show: if the source only has an incomplete pack,
      // reopening every night would re-download the same pack every night.
      if (hasRecentActivityEntry(movie.id, 'integrity_missing', 7 * 24)) continue;
      // The missing episodes themselves too: left 'downloaded', the next search
      // saw every episode done, closed the season again and fetched nothing.
      const onDisk = new Set((bySeason.get(dbSeason.season_number) || []).map(e => e.episode));
      for (const ep of getEpisodesBySeasonId(dbSeason.id)) {
        if (ep.episode_number <= aired && !onDisk.has(ep.episode_number) && ep.status === 'downloaded') {
          updateEpisodeStatus(ep.id, 'pending');
        }
      }
      updateSeasonStatus(dbSeason.id, 'pending');
      updateMovieStatus(movie.id, 'pending');
      setRepairFlag(movie.id, true);
      addLogEntry(movie.id, 'integrity_missing',
        `${sLabel}: nur ${present} von ${aired} Folgen in der Bibliothek — Staffel wird neu geladen`);
      sendTelegramNotification('error', movie.title, movie.year ?? 0,
        `Staffel ${dbSeason.season_number} war unvollständig (${present} von ${aired} Folgen) — ich lade sie neu.`, movie.imdb_id)
        .catch(() => { /* best effort */ });
      eventBus.emit('movie:updated', { id: movie.id, title: movie.title });
    }

    result.cleaned += cleanupQuarantine(showDir, healthyKeys);
  }

  if (result.flagged.length > 0 || result.missing.length > 0 || result.cleaned > 0) {
    logger.info(`Integrity check: ${result.flagged.length} incomplete episode(s) flagged, ${result.missing.length} season(s) with missing episodes, ${result.cleaned} stale quarantine(s) cleaned across ${result.scannedShows} show(s)`);
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
  if (!normalizeTitle(movie.title)) return [];
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch { return []; }
  const out: string[] = [];
  for (const name of entries) {
    // Same identity rule as the library checks: the part before the year is the
    // title, and the year (when known) agrees — a remake or a longer title of
    // the same year is not probed against the wrong file.
    if (!nameIsTitle(name, movie.title, movie.year)) continue;
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

// ── Truncation check ────────────────────────────────────────────────────────

/**
 * Files already judged (path → size), persisted in file_checks. The library is
 * worked through in slices (TRUNCATION_BUDGET per pass); a changed size
 * (re-download) is judged again.
 */
let truncationMemo: Map<string, number> | null = null;
const TRUNCATION_BUDGET = 60;

export function _resetTruncationMemo(): void { truncationMemo = null; }

function rememberJudged(file: string, size: number): void {
  truncationMemo!.set(file, size);
  markFileChecked(file, size);
}

export interface TruncationResult { probed: number; truncated: { movieId: number; title: string; file: string; detail: string }[] }

/**
 * Library files that do not play to the end. The size test above compares an
 * episode with its season's median — when a whole season is cut off (one
 * really was: ten episodes, each ending between minute 6 and 41) the median is
 * broken too and most of it went unnoticed. A cut MKV keeps its full length in
 * the header, so the check reads the last real video packet near the end, and
 * confirms with a full read before it acts.
 *
 * Episodes are quarantined and reset like the size test does; a film is put
 * back into the queue under repair — its file stays until a complete copy
 * replaces it.
 */
export async function runTruncationCheck(
  opts: { budget?: number; deps?: {
    duration: (f: string) => Promise<number | null>;
    tail: (f: string, d: number) => Promise<number | null>;
    full: (f: string) => Promise<number | null>;
  } } = {},
): Promise<TruncationResult> {
  const result: TruncationResult = { probed: 0, truncated: [] };
  if (getSetting('integrity.verify_import') === 'false') return result;
  const deps = opts.deps ?? { duration: mediaDurationSeconds, tail: lastVideoPacketSeconds, full: lastVideoPacketSecondsFullScan };
  let budget = opts.budget ?? TRUNCATION_BUDGET;
  if (!truncationMemo) {
    truncationMemo = loadCheckedFiles();
    pruneCheckedFiles(p => fs.existsSync(p));
  }
  const memo = truncationMemo;

  for (const movie of getAllMovies().filter(m => m.status === 'downloaded')) {
    if (budget <= 0) break;
    // The memo lives in memory only: after a restart a title with no usable
    // replacement would be flagged again (and notified again) every time.
    if (hasRecentActivityEntry(movie.id, 'integrity_incomplete', 7 * 24)) continue;
    const root = resolveLibraryTarget(movie);
    if (!root || !fs.existsSync(root)) continue;
    const isShow = movie.media_type === 'show';
    let files: { file: string; season?: number; episode?: number }[];
    if (isShow) {
      const showDir = findShowDir(root, movie);
      files = showDir ? collectShowEpisodes(showDir) : [];
    } else {
      files = collectMovieFiles(root, movie).map(file => ({ file }));
    }

    for (const f of files) {
      if (budget <= 0) break;
      let size = 0;
      try { size = fs.statSync(f.file).size; } catch { continue; }
      if (memo.get(f.file) === size) continue;
      budget--;
      result.probed++;
      const duration = await deps.duration(f.file);
      // Cannot judge (no duration, unreadable, slow mount): remember that too,
      // or the same unjudgeable files eat the budget of every pass.
      if (duration === null) { rememberJudged(f.file, size); continue; }
      let verdict = truncationVerdict(duration, await deps.tail(f.file, duration));
      if (!verdict.ok) verdict = truncationVerdict(duration, await deps.full(f.file));
      rememberJudged(f.file, size);
      if (verdict.ok) continue;

      const detail = verdict.detail;
      result.truncated.push({ movieId: movie.id, title: movie.title, file: f.file, detail });
      logger.warn(`Integrity: ${movie.title} — ${path.basename(f.file)}: ${detail}`);

      if (isShow && f.season != null && f.episode != null) {
        const epLabel = `S${String(f.season).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}`;
        try { fs.renameSync(f.file, f.file + QUARANTINE_SUFFIX); } catch (err: any) {
          logger.error(`Integrity: failed to quarantine ${epLabel} of ${movie.title}: ${err.message}`);
          continue;
        }
        const dbSeason = getSeasonsByShowId(movie.id).find(x => x.season_number === f.season);
        const dbEp = dbSeason ? getEpisodesBySeasonId(dbSeason.id).find(e => e.episode_number === f.episode) : undefined;
        if (dbEp) updateEpisodeStatus(dbEp.id, 'pending');
        if (dbSeason && dbSeason.status === 'downloaded') updateSeasonStatus(dbSeason.id, 'pending');
        // The show must leave 'downloaded' too: the post-processor closes a
        // 'pending' season of a downloaded show without sources straight away.
        updateMovieStatus(movie.id, 'pending');
        setRepairFlag(movie.id, true);
        addLogEntry(movie.id, 'integrity_incomplete', `${epLabel}: ${detail} — wird neu geladen`);
        sendTelegramNotification('error', movie.title, movie.year ?? 0,
          `Folge ${epLabel} ist unvollständig (${detail}) — ich lade sie neu.`, movie.imdb_id)
          .catch(() => { /* best effort */ });
      } else if (!isShow) {
        setRepairFlag(movie.id, true);
        updateMovieStatus(movie.id, 'pending');
        addLogEntry(movie.id, 'integrity_incomplete', `${detail} — wird neu geladen, die alte Datei bleibt bis dahin`);
        sendTelegramNotification('error', movie.title, movie.year ?? 0,
          `Die Datei ist unvollständig (${detail}) — ich lade den Film neu.`, movie.imdb_id)
          .catch(() => { /* best effort */ });
      }
      eventBus.emit('movie:updated', { id: movie.id, title: movie.title });
    }
  }
  if (result.probed > 0) {
    logger.info(`Truncation check: ${result.truncated.length} incomplete file(s) of ${result.probed} probed`);
  }
  return result;
}
