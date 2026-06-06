import fs from 'fs';
import path from 'path';
import { getSetting } from '../database/index';
import {
  getMovieByTmdbId, updateMovieStatus, setRepairFlag, type Movie,
} from '../database/services/movies';
import { getSeasonsByShowId, updateSeasonStatus } from '../database/services/seasons';
import { getEpisodesBySeasonId, updateEpisodeStatus } from '../database/services/episodes';
import { getDownloadsByMovieId } from '../database/services/downloads';
import { addBlocklistEntry } from '../database/services/blocklist';
import { addLogEntry } from '../database/services/activityLog';
import { seerrService, type SeerrIssue } from './seerr';
import { normalizeTitle, resolveLibraryTarget } from './postprocess';
import { logger } from '../utils/logger';

/**
 * Turns a viewer's problem report in Seerr into a re-download.
 *
 * This is a capability dlvault had no equivalent of: until now a broken file was
 * only ever found by its own integrity check, and someone watching a film with
 * the wrong audio track had no way to say so except messaging the owner.
 *
 * The mechanism is the one the integrity check already uses — reset to pending,
 * flag as under repair — plus the step it does not need: **blocklist the release
 * that is on disk**. Without that, the pipeline would happily fetch the very
 * same file again and the report would achieve nothing.
 *
 * dlvault marks its own work by commenting on the issue. That comment is also
 * how it recognises, on the next sweep, that it has already acted — no extra
 * bookkeeping table, and the reasoning is visible to whoever reported it.
 */

/** Seerr `IssueType`. */
const ISSUE_VIDEO = 1;
const ISSUE_AUDIO = 2;
const ISSUE_SUBTITLES = 3;
const ISSUE_OTHER = 4;

/** Seerr `IssueStatus`. */
const ISSUE_OPEN = 1;

/** Prefix that marks a comment as dlvault's own. */
const MARKER = '[dlvault]';

const TYPE_LABEL: Record<number, string> = {
  [ISSUE_VIDEO]: 'Bild',
  [ISSUE_AUDIO]: 'Ton',
  [ISSUE_SUBTITLES]: 'Untertitel',
  [ISSUE_OTHER]: 'Sonstiges',
};

/** Problems a different release can plausibly fix. */
const REDOWNLOADABLE = new Set([ISSUE_VIDEO, ISSUE_AUDIO, ISSUE_SUBTITLES]);

function enabled(): boolean {
  return getSetting('seerr.issues_enabled') === 'true';
}

/** Whether dlvault has already responded to this issue. */
function alreadyHandled(issue: SeerrIssue): boolean {
  return (issue.comments || []).some(c => typeof c.message === 'string' && c.message.startsWith(MARKER));
}

/**
 * Blocks every release currently recorded for a title so the next search cannot
 * return the same file.
 *
 * @returns the release names that were blocked.
 */
function blocklistCurrentReleases(movie: Movie, reason: string, seasonNumber: number | null): string[] {
  const blocked: string[] = [];
  for (const d of getDownloadsByMovieId(movie.id)) {
    if (!d.release_name) continue;
    // A season-scoped report must not blocklist the rest of the show.
    if (seasonNumber != null && d.season_number != null && d.season_number !== seasonNumber) continue;
    if (blocked.includes(d.release_name)) continue;
    addBlocklistEntry({
      release_name: d.release_name,
      title: movie.title,
      reason,
      movie_id: movie.id,
    });
    blocked.push(d.release_name);
  }
  return blocked;
}

/** Suffix the integrity check uses; reusing it keeps one convention. */
const QUARANTINE_SUFFIX = '.incomplete';
const MEDIA_EXT_RE = /\.(mkv|mp4|avi|m4v|wmv|ts)$/i;

/**
 * Moves the reported file aside before a fresh search starts.
 *
 * Without this the report achieves nothing: dlvault resets the title to
 * pending, and its own library check finds the same bad file still sitting
 * there and flips it straight back to 'downloaded'. Observed in the field with
 * 27 seconds between the two log lines — the re-download was cancelled before
 * it began.
 *
 * Renamed rather than deleted: the viewer might be wrong, the replacement might
 * never arrive, and a file that turns out to be fine is recoverable. The
 * integrity check's own sweep removes stale quarantine files once a healthy
 * replacement is in place.
 *
 * @returns how many files were moved aside.
 */
function quarantineReportedFiles(movie: Movie, seasonNumber: number | null): number {
  const root = resolveLibraryTarget(movie);
  if (!root || !fs.existsSync(root)) return 0;

  const wanted = normalizeTitle(movie.title);
  let moved = 0;

  const sweep = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 2) sweep(full, depth + 1);
        continue;
      }
      if (!MEDIA_EXT_RE.test(e.name)) continue;
      // Season-scoped reports must leave the other seasons alone.
      if (seasonNumber != null && !new RegExp(`s0*${seasonNumber}(?![0-9])`, 'i').test(e.name)) continue;
      try {
        fs.renameSync(full, full + QUARANTINE_SUFFIX);
        moved++;
        logger.info(`Seerr issue: quarantined "${e.name}"`);
      } catch (error: any) {
        logger.warn(`Seerr issue: could not quarantine "${e.name}": ${error?.message || error}`);
      }
    }
  };

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (normalizeTitle(entry.name).startsWith(wanted)) sweep(path.join(root, entry.name), 1);
  }
  return moved;
}

/**
 * Resets exactly the scope the report names: an episode, a season, or the whole
 * title. Reporting one bad episode must not re-fetch four other seasons.
 */
function resetScope(movie: Movie, seasonNumber: number | null, episodeNumber: number | null): { de: string; en: string } {
  if (movie.media_type !== 'show' || !seasonNumber) {
    updateMovieStatus(movie.id, 'pending');
    return movie.media_type === 'show'
      ? { de: 'die ganze Serie', en: 'the whole show' }
      : { de: 'den Film', en: 'the film' };
  }

  const season = getSeasonsByShowId(movie.id).find(s => s.season_number === seasonNumber);
  if (!season) {
    updateMovieStatus(movie.id, 'pending');
    return { de: 'die ganze Serie', en: 'the whole show' };
  }

  if (episodeNumber) {
    const ep = getEpisodesBySeasonId(season.id).find(e => e.episode_number === episodeNumber);
    if (ep) {
      updateEpisodeStatus(ep.id, 'pending');
      updateSeasonStatus(season.id, 'pending');
      updateMovieStatus(movie.id, 'pending');
      const code = `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
      return { de: code, en: code };
    }
  }

  updateSeasonStatus(season.id, 'pending');
  updateMovieStatus(movie.id, 'pending');
  return { de: `Staffel ${seasonNumber}`, en: `season ${seasonNumber}` };
}

/**
 * Puts quarantined files back.
 *
 * Called when a repair is abandoned: dlvault took the old copy away expecting a
 * replacement, and none arrived. Leaving the viewer with nothing at all would be
 * a worse outcome than the flaw they reported.
 *
 * @returns how many files were restored.
 */
export function restoreQuarantinedFiles(movie: Movie): number {
  const root = resolveLibraryTarget(movie);
  if (!root || !fs.existsSync(root)) return 0;

  const wanted = normalizeTitle(movie.title);
  let restored = 0;

  const sweep = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 2) sweep(full, depth + 1);
        continue;
      }
      if (!e.name.endsWith(QUARANTINE_SUFFIX)) continue;
      try {
        fs.renameSync(full, full.slice(0, -QUARANTINE_SUFFIX.length));
        restored++;
        logger.info(`Seerr issue: restored "${e.name}" — no replacement was found`);
      } catch (error: any) {
        logger.warn(`Seerr issue: could not restore "${e.name}": ${error?.message || error}`);
      }
    }
  };

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (normalizeTitle(entry.name).startsWith(wanted)) sweep(path.join(root, entry.name), 1);
  }
  return restored;
}

/**
 * Tells Seerr that a title has not turned up yet — and that dlvault is still
 * watching for it.
 *
 * Until now that news went to Telegram only, so whoever asked through Seerr saw
 * "Angefragt" indefinitely with no idea whether anything was happening.
 *
 * It deliberately says "still looking", not "gave up": since the retry ceiling
 * became a standing watch on the configured schedule rather than a full stop,
 * giving up is no longer what happens.
 *
 * Reported as an issue rather than by declining the request. Declining is
 * available (and answers 200), but it is wrong twice over: nobody declined
 * anything — dlvault simply could not find it — and a declined request is
 * exactly what dropDeclined() deletes titles for, so dlvault would end up
 * erasing its own entry.
 *
 * @returns true when Seerr was told.
 */
export async function reportGiveUp(movie: Movie, restored: number): Promise<boolean> {
  if (!enabled() || !seerrService.isConfigured() || !movie.tmdb_id) return false;

  const requests = await seerrService.getRequests();
  if (requests === null) return false;
  const match = requests.find(r => r.media?.tmdbId === movie.tmdb_id);
  if (!match?.media?.id) return false;   // nobody asked for it through Seerr

  // Say nothing about a film that simply has not come out yet. Ten fruitless
  // searches for "The Beekeeper 2 (2027)" measure nothing but patience, and
  // people deliberately park upcoming titles in the queue — telling them it
  // "wasn't found" is noise about something working exactly as intended.
  const meta = await seerrService.getMeta(match.type === 'tv' ? 'tv' : 'movie', movie.tmdb_id);
  if (meta?.releaseDate && Date.parse(meta.releaseDate) > Date.now()) {
    logger.info(`Seerr: staying quiet about "${movie.title}" — not released until ${meta.releaseDate}`);
    return false;
  }

  const restoredNote = restored > 0
    ? ` Die zuvor beiseitegelegte Datei wurde wiederhergestellt (${restored}) — sie ist wieder abspielbar.`
    : '';

  const created = await seerrService.createIssue(
    match.media.id,
    ISSUE_OTHER,
    `${MARKER} Für „${movie.title}" ist bislang kein passendes Release aufgetaucht. dlvault sucht im eingestellten Intervall weiter.${restoredNote}`,
  );
  if (created) {
    addLogEntry(movie.id, 'seerr_still_looking', `Seerr informiert: ${movie.title} noch nicht verfügbar, Suche läuft weiter`);
    logger.info(`Seerr: reported "${movie.title}" as not yet obtainable — still watching`);
  }
  return created;
}

/** Acts on one open issue. @returns true when something was done. */
async function handleIssue(issue: SeerrIssue): Promise<boolean> {
  const tmdbId = issue.media?.tmdbId;
  if (!tmdbId) return false;

  const mediaType = issue.media.mediaType === 'tv' ? 'show' : 'movie';
  const movie = getMovieByTmdbId(tmdbId, mediaType);
  if (!movie) {
    await seerrService.commentOnIssue(issue.id,
      `${MARKER} Dieser Titel wird von dlvault nicht verwaltet — hier kann automatisch nichts unternommen werden.`);
    return true;
  }

  const label = TYPE_LABEL[issue.issueType] || 'Problem';

  if (!REDOWNLOADABLE.has(issue.issueType)) {
    // "Other" covers everything from a wrong title to a broken poster. Guessing
    // at a fix would waste bandwidth; saying so plainly is more use.
    await seerrService.commentOnIssue(issue.id,
      `${MARKER} Gemeldet: ${label}. Dafür gibt es keine automatische Abhilfe — bitte manuell ansehen.`);
    return true;
  }

  if (movie.status === 'downloading' || movie.status === 'searching') {
    await seerrService.commentOnIssue(issue.id,
      `${MARKER} Für „${movie.title}" läuft bereits ein Download — die Meldung wird danach erneut geprüft.`);
    return false;   // no marker consumed: look at it again once the run settles
  }

  const season = issue.problemSeason || null;
  const episode = issue.problemEpisode || null;
  const blocked = blocklistCurrentReleases(movie, `Seerr-Meldung: ${label}`, season);
  // Order matters: move the file aside BEFORE resetting, or the library check
  // can win the race and mark the title downloaded again.
  const quarantined = quarantineReportedFiles(movie, season);
  const scope = resetScope(movie, season, episode);
  setRepairFlag(movie.id, true);

  const blockedNote = blocked.length > 0
    ? `Gesperrt: ${blocked.map(b => `„${b}"`).join(', ')}.`
    : 'Es war kein Release vermerkt, das gesperrt werden konnte — die Suche läuft trotzdem neu.';

  const fileNote = quarantined > 0
    ? ` Die bisherige Datei wurde beiseitegelegt (${quarantined}).`
    : ' Es lag keine Datei zum Beiseitelegen vor.';

  await seerrService.commentOnIssue(issue.id,
    `${MARKER} Gemeldet: ${label}. dlvault sucht ${scope.de} neu. ${blockedNote}${fileNote}`);

  addLogEntry(movie.id, 'issue_redownload',
    `Seerr-Meldung (${label}): ${scope.de} wird neu geladen, ${blocked.length} Release(s) gesperrt, ${quarantined} Datei(en) beiseitegelegt`);
  logger.info(`Seerr issue #${issue.id} (${label}): re-downloading ${scope.en} of "${movie.title}", blocked ${blocked.length} release(s), quarantined ${quarantined} file(s)`);
  return true;
}

/**
 * Closes issues whose title has since come back complete.
 *
 * Only issues dlvault actually acted on are closed — a report it merely
 * commented "no automatic fix" on stays open for a human.
 */
async function resolveFixedIssues(issues: SeerrIssue[]): Promise<number> {
  let resolved = 0;
  for (const issue of issues) {
    if (!alreadyHandled(issue)) continue;
    const actedOn = (issue.comments || []).some(c =>
      typeof c.message === 'string' && c.message.startsWith(MARKER) && c.message.includes('sucht'));
    if (!actedOn) continue;

    const tmdbId = issue.media?.tmdbId;
    if (!tmdbId) continue;
    const mediaType = issue.media.mediaType === 'tv' ? 'show' : 'movie';
    const movie = getMovieByTmdbId(tmdbId, mediaType);
    // `repair` clears exactly when a title next reaches 'downloaded', so the two
    // conditions together mean "the replacement has landed".
    if (!movie || movie.status !== 'downloaded' || movie.repair !== 0) continue;

    await seerrService.commentOnIssue(issue.id,
      `${MARKER} Ein anderes Release ist heruntergeladen und in der Bibliothek. Bitte noch einmal prüfen.`);
    if (await seerrService.setIssueStatus(issue.id, 'resolved')) {
      resolved++;
      logger.info(`Seerr issue #${issue.id} resolved — "${movie.title}" replaced`);
    }
  }
  return resolved;
}

/**
 * One pass over Seerr's open issues.
 *
 * @returns how many issues were acted on.
 */
let sweepRunning = false;

/** Test seam. */
export function _resetIssueSweepState(): void {
  sweepRunning = false;
}

export async function processSeerrIssues(): Promise<number> {
  if (!enabled() || !seerrService.isConfigured()) return 0;
  // Two callers reach this: the webhook (immediately) and the two-minute sweep.
  // They can overlap, and "already handled" is read from a comment that is only
  // written AFTER the work — so both passes would see the same report as fresh
  // and act on it twice: blocklisting twice, resetting twice, commenting twice.
  if (sweepRunning) return 0;
  sweepRunning = true;
  try {
    return await runSweep();
  } finally {
    sweepRunning = false;
  }
}

async function runSweep(): Promise<number> {

  const issues = await seerrService.getIssues();
  if (issues === null) return 0;

  const open = issues.filter(i => i.status === ISSUE_OPEN);
  if (open.length === 0) return 0;

  let handled = 0;
  for (const issue of open) {
    try {
      if (alreadyHandled(issue)) continue;
      if (await handleIssue(issue)) handled++;
    } catch (error: any) {
      logger.error(`Seerr issue #${issue.id} could not be processed: ${error?.message || error}`);
    }
  }

  await resolveFixedIssues(open);
  return handled;
}
