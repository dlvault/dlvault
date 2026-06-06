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
 * Audio-track language tags of a media file (lowercased, in stream order).
 *
 * Returns `null` when ffprobe cannot produce a verdict — binary missing, spawn
 * error, timeout, or non-zero exit. Callers MUST treat null as "cannot judge"
 * and never as "no language present", otherwise a missing ffprobe would flag
 * every file. An empty array means audio streams exist but none carry a usable
 * language tag (also "cannot judge" for the language check).
 */
export function audioLanguageTags(file: string, timeoutMs = 15000): Promise<string[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    let child;
    try {
      child = spawn(FFPROBE_BIN, [
        '-v', 'error',
        '-select_streams', 'a',
        '-show_entries', 'stream_tags=language',
        '-of', 'json',
        file,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
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
      finish(code === 0 ? parseAudioLanguageJson(out) : null);
    });
  });
}
