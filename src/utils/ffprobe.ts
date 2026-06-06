import { spawn } from 'child_process';
import { logger } from './logger';

// ffprobe binary: overridable for bare-metal installs that keep ffmpeg
// elsewhere; defaults to the PATH lookup (the Docker image ships ffmpeg).
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

// Warn only once if ffprobe isn't installed — the opt-in audio-language check
// then simply does nothing rather than spamming the log every scan.
let ffprobeMissingWarned = false;

/**
 * ISO-639 code sets per human-readable language. Release/container audio tags
 * use a mix of 639-2/B ("ger"), 639-2/T ("deu") and 639-1 ("de"), plus the
 * occasional spelled-out form, so we accept all of them.
 */
const LANG_CODES: Record<string, string[]> = {
  german:  ['ger', 'deu', 'de', 'german', 'deutsch'],
  english: ['eng', 'en', 'english'],
  french:  ['fre', 'fra', 'fr', 'french'],
  spanish: ['spa', 'es', 'esp', 'spanish'],
  italian: ['ita', 'it', 'italian'],
  dutch:   ['dut', 'nld', 'nl', 'dutch'],
  polish:  ['pol', 'pl', 'polish'],
};

/** Accepted audio-tag codes for a configured `quality.language` value. */
export function wantedLanguageCodes(wanted: string): string[] {
  const w = (wanted || '').toLowerCase().trim();
  if (LANG_CODES[w]) return LANG_CODES[w];
  // Unknown language: fall back to the literal plus its 2/3-letter prefixes so
  // an exact-or-near tag still matches (e.g. "portuguese" → por/pt).
  return [...new Set([w, w.slice(0, 2), w.slice(0, 3)].filter(Boolean))];
}

/** True if any of the file's audio language tags satisfies the wanted language. */
export function audioMatchesLanguage(tags: string[], wanted: string): boolean {
  const codes = new Set(wantedLanguageCodes(wanted));
  return tags.some(t => codes.has(t));
}

/**
 * Pure parser for ffprobe's `-show_entries stream_tags=language -of json`
 * output. Returns the audio-stream language tags, lowercased, with the
 * no-signal values ('und'/'unknown') dropped. Kept separate from the spawn
 * wiring so it can be unit-tested without a real ffprobe.
 */
export function parseAudioLanguageJson(stdout: string): string[] {
  let json: any;
  try { json = JSON.parse(stdout); } catch { return []; }
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  return streams
    .map((s: any) => String(s?.tags?.language ?? '').toLowerCase().trim())
    .filter((l: string) => l && l !== 'und' && l !== 'unknown');
}

/**
 * Run ffprobe and return its stdout, or `null` when it cannot produce a verdict
 * — binary missing, spawn error, timeout, or non-zero exit. Never throws.
 */
function runFfprobe(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    // Declared up here on purpose: the catch around spawn() below calls finish()
    // BEFORE the timer is created. With `timer` declared after finish, that hit
    // the temporal dead zone and threw a ReferenceError out of the promise —
    // so a synchronous spawn failure (EPERM, or EMFILE during a large scan)
    // rejected instead of resolving null, and took the whole integrity scan with
    // it. The callers rely on this function never throwing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (val: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(val);
    };

    let child;
    try {
      child = spawn(FFPROBE_BIN, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      try { child!.kill('SIGKILL'); } catch { /* noop */ }
      finish(null);
    }, timeoutMs);

    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' && !ffprobeMissingWarned) {
        ffprobeMissingWarned = true;
        logger.warn(
          `ffprobe not found ("${FFPROBE_BIN}") — audio-language verification is disabled. ` +
          'Install ffmpeg (it ships with the official Docker image) or set FFPROBE_PATH.',
        );
      }
      finish(null);
    });

    child.on('close', (code: number | null) => {
      finish(code === 0 ? out : null);
    });
  });
}

/**
 * Audio-track language tags of a media file (lowercased, in stream order).
 *
 * Returns `null` when ffprobe cannot produce a verdict. Callers MUST treat null
 * as "cannot judge" and never as "no language present", otherwise a missing
 * ffprobe would flag every file. An empty array means audio streams exist but
 * none carry a usable language tag (also "cannot judge" for the language check).
 */
export async function audioLanguageTags(file: string, timeoutMs = 15000): Promise<string[] | null> {
  const out = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream_tags=language',
    '-of', 'json',
    file,
  ], timeoutMs);
  return out === null ? null : parseAudioLanguageJson(out);
}

/** One audio stream: language tag (lowercased, '' when untagged) and channel count. */
export interface AudioTrack { language: string; channels: number }

/** Pure parser for `-show_entries stream=channels:stream_tags=language -of json`. */
export function parseAudioTracksJson(stdout: string): AudioTrack[] {
  let json: any;
  try { json = JSON.parse(stdout); } catch { return []; }
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  return streams.map((st: any) => ({
    language: String(st?.tags?.language || '').toLowerCase(),
    channels: Number(st?.channels) || 0,
  }));
}

/** Audio streams with language and channel count, or null when ffprobe cannot tell. */
export async function audioTracks(file: string, timeoutMs = 15000): Promise<AudioTrack[] | null> {
  const out = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=channels:stream_tags=language',
    '-of', 'json',
    file,
  ], timeoutMs);
  return out === null ? null : parseAudioTracksJson(out);
}

/** Pure parser for `-show_entries format=duration -of default=nw=1:nk=1`. */
export function parseDurationOutput(stdout: string): number | null {
  const n = parseFloat(stdout.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Playing time of a media file in seconds, or null when it cannot be read. */
export async function mediaDurationSeconds(file: string, timeoutMs = 15000): Promise<number | null> {
  const out = await runFfprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ], timeoutMs);
  return out === null ? null : parseDurationOutput(out);
}

/** Pure parser: the last finite timestamp of `-show_entries packet=pts_time -of csv=p=0`. */
export function parseLastPacketTime(stdout: string): number | null {
  let last: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const n = parseFloat(line.trim().replace(/,$/, ''));
    if (Number.isFinite(n)) last = n;
  }
  return last;
}

/**
 * Timestamp of the last video packet near the end of a file. A truncated MKV
 * keeps the full playing time in its header — the duration check cannot see
 * the cut — but has no packets past it: seeking to the end lands on the last
 * packet that really exists. Reads only the tail, so it is cheap.
 */
export async function lastVideoPacketSeconds(file: string, durationSec: number, timeoutMs = 30000): Promise<number | null> {
  const start = Math.max(0, Math.floor(durationSec - 30));
  const out = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-read_intervals', `${start}%+40`,
    '-show_entries', 'packet=pts_time',
    '-of', 'csv=p=0',
    file,
  ], timeoutMs);
  return out === null ? null : parseLastPacketTime(out);
}

/**
 * Same question answered by reading the WHOLE file — slow (seconds per GB), so
 * only to confirm a tail check before anything is quarantined: a file whose
 * seek misbehaves must never be hidden from the library on that alone.
 */
export async function lastVideoPacketSecondsFullScan(file: string, timeoutMs = 10 * 60 * 1000): Promise<number | null> {
  const out = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time',
    '-of', 'csv=p=0',
    file,
  ], timeoutMs);
  return out === null ? null : parseLastPacketTime(out);
}
