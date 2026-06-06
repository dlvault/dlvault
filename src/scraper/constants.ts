export type ReleaseType = 'remux' | 'complete' | 'rip' | 'unknown';

export interface ScrapedRelease {
  title: string;
  quality: string;
  audio: string;
  language: string;
  size: string;
  releaseType: ReleaseType;
  isDolbyVision: boolean;
  season: number | null; // Parsed season number (e.g. from "Staffel 1", "S01")
  episode: number | null; // Parsed episode number (e.g. from "S02E05", "E05")
  isSeasonPack: boolean; // True if season release without episode number (complete season)
  links: { hoster: string; url: string }[];
  // Diagnostic note populated by the source plugin when link resolution
  // fails (e.g. captcha exhaustion, container offline). Carried through to
  // the scheduler so error logs/Telegram messages can explain *why* a release
  // was skipped instead of just "no usable links".
  _resolutionDiagnostic?: string;
}

export const QUALITY_RANK: Record<string, number> = {
  '2160p': 4,
  '1080p': 3,
  '720p': 2,
  '480p': 1,
};

// Canonical audio ranks. The bundled plugins normalize to the short tokens
// ('7.1'/'5.1'/'2.0'/'atmos'/'dts'/'unknown'), but third-party plugins may emit
// raw codec names — list the common ones so a genuinely good track isn't ranked
// 0 (and thus dropped by a min-audio filter / sorted below stereo). Look up via
// audioRank() so the match is case-insensitive.
export const AUDIO_RANK: Record<string, number> = {
  '7.1': 4,
  'atmos': 4,
  'truehd': 4,   // Dolby TrueHD — lossless, usually the Atmos bed
  'dts-hd': 4,   // DTS-HD MA — lossless
  'dtshd': 4,
  'dts-ma': 4,
  'dts-x': 4,
  'dtsx': 4,
  '5.1': 3,
  'dts': 3,
  'eac3': 3,     // Dolby Digital Plus (E-AC3) — lossy 5.1+
  'dd+': 3,
  'ddp': 3,
  'ac3': 3,      // Dolby Digital 5.1
  '2.0': 1,
  'stereo': 1,
};

/**
 * Case-insensitive audio rank lookup. Returns 0 for unknown/unrecognized audio
 * — callers should treat 0 as "can't judge" (like 'unknown'), not "worst", so
 * an unrecognized codec is never silently filtered out.
 */
export function audioRank(audio: string): number {
  return AUDIO_RANK[(audio || '').toLowerCase()] || 0;
}

const SIZE_UNIT_MB: Record<string, number> = {
  tb: 1024 * 1024,
  gb: 1024,
  mb: 1,
  kb: 1 / 1024,
};

/**
 * Parse a human-readable size string ("21.9 GB", "700 MB", "1,5 TB", "5GB")
 * into a comparable number of megabytes. Accepts '.' or ',' as the decimal
 * separator — German release sites use both. Unparseable/empty → 0, so a
 * release with no detected size sorts last on the size tiebreaker instead of
 * jumping ahead of releases whose size we actually know.
 */
export function parseSizeToMB(size: string): number {
  const m = (size || '').match(/([\d.,]+)\s*(tb|gb|mb|kb)/i);
  if (!m) return 0;

  // Normalize mixed '.'/',' grouping. The LAST separator is the decimal point;
  // any earlier separators are thousands groupings to strip. A single separator
  // followed by exactly three digits is a thousands group, not a decimal
  // (release sizes use 1–2 decimal digits) — so "1.234" → 1234, but "21.9" →
  // 21.9, "1,5" → 1.5, "1.234,5" → 1234.5 and "1,234.5" → 1234.5.
  let digits = m[1];
  const lastSep = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','));
  if (lastSep >= 0) {
    const head = digits.slice(0, lastSep);
    const tail = digits.slice(lastSep + 1);
    const intPart = head.replace(/[.,]/g, '');
    if (tail.length === 3 && !/[.,]/.test(head)) {
      digits = intPart + tail;              // lone 3-digit group → thousands
    } else {
      digits = `${intPart}.${tail}`;        // last separator is the decimal point
    }
  }

  const value = parseFloat(digits);
  if (!Number.isFinite(value)) return 0;
  return value * (SIZE_UNIT_MB[m[2].toLowerCase()] ?? 0);
}
