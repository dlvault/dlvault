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

export const AUDIO_RANK: Record<string, number> = {
  '7.1': 4,
  'atmos': 4,
  '5.1': 3,
  'dts': 3,
  '2.0': 1,
  'stereo': 1,
};
