import { getSetting } from '../database/index';
import { countBlocklistedWithReason } from '../database/services/blocklist';
import type { Movie } from '../database/services/movies';
import { audioLanguageTags, audioMatchesLanguage, mediaDurationSeconds, audioTracks, wantedLanguageCodes, lastVideoPacketSeconds, lastVideoPacketSecondsFullScan, type AudioTrack } from '../utils/ffprobe';

/**
 * Checks a finished download BEFORE it goes into the library.
 *
 * Until now only upgrades were checked, and only for language. What reached the
 * library unchecked, all observed on one real library: two films that were a
 * different film with a similar title, an English-only release taken for German,
 * and files a third longer than the film they were filed as. Each stayed there
 * unnoticed for weeks. Two cheap signals catch most of it:
 *
 * - Playing time against the film's known runtime. On a real library the ratio
 *   sat between 0.95 and 1.05 for 91 films; the wrong ones were at 1.34.
 * - Audio-track language tags, when the user asked for strict language.
 *
 * Neutral host: metadata and ffprobe only, nothing source-specific.
 */

export const RUNTIME_REASON = 'auto: Laufzeit passt nicht';
export const LANGUAGE_REASON = 'auto: falsche Tonspur';
export const CHANNELS_REASON = 'auto: Tonspur unter Minimum';
export const TRUNCATED_REASON = 'auto: Datei unvollständig';

/** Cut / edition tags that legitimately make a film longer. */
const LONG_CUT_RE = /(^|[^a-z])(extended|director'?s|dc|uncut|unrated|ultimate|special[ .]?edition|longer)([^a-z]|$)/i;

export type ImportVerdict =
  | { ok: true }
  | { ok: false; kind: 'runtime' | 'language' | 'channels' | 'truncated'; reason: string; detail: string; retryLater?: boolean };

/** A file still written to (extraction, copy) looks cut off — judge it later. */
const SETTLE_MS = 10 * 60 * 1000;

/**
 * Pure rule for the runtime check. `expectedMin` comes from metadata, which can
 * be plainly wrong ("2 min" for a feature film) — implausible values are not
 * judged.
 */
export function runtimeVerdict(actualSec: number, expectedMin: number | null | undefined, releaseName = ''): ImportVerdict {
  if (!expectedMin || expectedMin < 40 || expectedMin > 400 || !(actualSec > 0)) return { ok: true };
  const ratio = actualSec / 60 / expectedMin;
  const max = LONG_CUT_RE.test(releaseName) ? 1.6 : 1.3;
  if (ratio >= 0.8 && ratio <= max) return { ok: true };
  const detail = `${Math.round(actualSec / 60)} min statt ${expectedMin} min`;
  return { ok: false, kind: 'runtime', reason: `${RUNTIME_REASON} (${detail})`, detail };
}

/**
 * Pure rule: does the file really play to the end? `lastSec` is the last video
 * packet near the end; a file cut off at 12 of 47 minutes still reports 47 in
 * its header. Two minutes of slack for trailing credits without video packets.
 */
export function truncationVerdict(durationSec: number | null, lastSec: number | null): ImportVerdict {
  if (durationSec === null || lastSec === null || durationSec < 300) return { ok: true };
  if (lastSec + 120 >= durationSec) return { ok: true };
  const detail = `Datei bricht nach ${Math.round(lastSec / 60)} von ${Math.round(durationSec / 60)} Minuten ab`;
  return { ok: false, kind: 'truncated', reason: `${TRUNCATED_REASON} (${detail})`, detail };
}

/** Truncation check for one file; null probes are "cannot judge" and pass. */
export async function checkTruncation(file: string, now = Date.now()): Promise<ImportVerdict> {
  const duration = await mediaDurationSeconds(file);
  if (duration === null) return { ok: true };
  const v = truncationVerdict(duration, await lastVideoPacketSeconds(file, duration));
  if (v.ok) return v;
  // Written to within the last minutes: probably still being extracted. Do not
  // reject (and blocklist) a good release for that — look again next cycle.
  let mtime = 0;
  try { mtime = (await import('fs')).statSync(file).mtimeMs; } catch { /* gone */ }
  if (now - mtime < SETTLE_MS) return { ...v, retryLater: true };
  // Rejecting deletes the download and blocklists the release — never on the
  // seek-based check alone (timestamp jumps, odd start offsets). Read it all.
  return truncationVerdict(duration, await lastVideoPacketSecondsFullScan(file));
}

/** Pure rule for the language check. Untagged audio cannot be judged. */
export function languageVerdict(tags: string[] | null, wanted: string): ImportVerdict {
  if (!tags || tags.length === 0) return { ok: true };
  if (audioMatchesLanguage(tags, wanted)) return { ok: true };
  const detail = `Tonspur ${tags.join(', ')} statt ${wanted}`;
  return { ok: false, kind: 'language', reason: `${LANGUAGE_REASON} (${detail})`, detail };
}

/** Channels a minimum-audio setting asks for: 7.1 = 8, 5.1 = 6, stereo = 2. */
function requiredChannels(minAudio: string): number {
  const m = (minAudio || '').toLowerCase();
  if (m === '7.1' || m === 'atmos' || m === 'truehd') return 8;
  if (m === '5.1' || m === 'dts' || m === 'eac3' || m === 'ac3') return 6;
  return 0;
}

/**
 * Pure rule: does the best audio track in the wanted language reach the
 * configured minimum? Sources label audio from the release name, and an
 * unlabelled release ('unknown') passes the search filter by design — two
 * stereo-only films reached a 5.1-only library that way. Untagged or missing
 * information cannot be judged and passes.
 */
export function channelsVerdict(tracks: AudioTrack[] | null, wanted: string, minAudio: string): ImportVerdict {
  const need = requiredChannels(minAudio);
  if (!need || !tracks || tracks.length === 0) return { ok: true };
  const anyLanguage = !wanted || wanted === 'any' || wanted === 'all';
  const codes = new Set(wantedLanguageCodes(wanted));
  const relevant = anyLanguage ? tracks : tracks.filter(t => codes.has(t.language));
  if (relevant.length === 0 || relevant.every(t => !t.channels)) return { ok: true };
  const best = Math.max(...relevant.map(t => t.channels));
  if (best >= need) return { ok: true };
  const detail = `${best === 2 ? 'Stereo' : `${best} Kanäle`} statt mind. ${minAudio}`;
  return { ok: false, kind: 'channels', reason: `${CHANNELS_REASON} (${detail})`, detail };
}

/**
 * Should this film's file go into the library?
 *
 * Language is judged for an upgrade always (it replaces a copy known to be
 * right) and otherwise only in strict-language mode. Runtime is judged unless
 * this title already lost two releases to it — then the metadata is the more
 * likely culprit, and refusing every release would leave the title empty.
 */
export async function verifyMovieImport(
  movie: Pick<Movie, 'id' | 'runtime' | 'media_type'>,
  file: string,
  releaseName: string,
  opts: { isUpgrade?: boolean } = {},
): Promise<ImportVerdict> {
  if (getSetting('integrity.verify_import') === 'false') return { ok: true };

  // A cut-off file is never worth importing — and for an upgrade it would
  // replace a complete copy.
  const cut = await checkTruncation(file);
  if (!cut.ok) return cut;

  const wanted = (getSetting('quality.language') || 'german').toLowerCase().trim();
  const anyLanguage = !wanted || wanted === 'any' || wanted === 'all';
  const strict = getSetting('quality.language_strict') === 'true';
  if (!anyLanguage && (strict || opts.isUpgrade)) {
    const v = languageVerdict(await audioLanguageTags(file), wanted);
    if (!v.ok) return v;
  }

  if (movie.media_type !== 'show') {
    const v = channelsVerdict(await audioTracks(file), anyLanguage ? '' : wanted, getSetting('quality.audio_minimum') || '');
    if (!v.ok) return v;
  }

  if (movie.media_type !== 'show' && countBlocklistedWithReason(movie.id, RUNTIME_REASON) < 2) {
    const seconds = await mediaDurationSeconds(file);
    if (seconds !== null) {
      const v = runtimeVerdict(seconds, movie.runtime, releaseName);
      if (!v.ok) return v;
    }
  }
  return { ok: true };
}

/**
 * Language check for a show's episode — strict mode only, since a show cannot
 * fall back to an "upgrade replaces a known copy" rule.
 */
export async function verifyEpisodeLanguage(file: string): Promise<ImportVerdict> {
  if (getSetting('integrity.verify_import') === 'false') return { ok: true };
  const wanted = (getSetting('quality.language') || 'german').toLowerCase().trim();
  if (!wanted || wanted === 'any' || wanted === 'all') return { ok: true };
  if (getSetting('quality.language_strict') !== 'true') return { ok: true };
  return languageVerdict(await audioLanguageTags(file), wanted);
}

/**
 * Every episode of a pack must play to the end. One season once went in with
 * all ten episodes cut off between minute 6 and 41 — nothing noticed it for
 * two months. Returns the first failing episode's verdict.
 */
export async function verifyEpisodesComplete(files: string[]): Promise<ImportVerdict & { file?: string }> {
  if (getSetting('integrity.verify_import') === 'false') return { ok: true };
  for (const file of files) {
    const v = await checkTruncation(file);
    if (!v.ok) {
      const name = file.split(/[\\/]/).pop() || file;
      return { ...v, detail: `${name}: ${v.detail}`, file };
    }
  }
  return { ok: true };
}
