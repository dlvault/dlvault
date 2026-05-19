import { getSetting } from '../database/index';
import { QUALITY_RANK, audioRank, parseSizeToMB, type ScrapedRelease } from './constants';

/**
 * Per-axis count of releases that failed each filter. Helps diagnose why a
 * release set ended up empty — see how it's used in scheduler.ts:
 * "all releases had no resolvable links" vs "below quality threshold" are
 * very different bugs from a user's POV.
 */
export interface FilterStats {
  total: number;
  qualityFail: number;
  audioFail: number;
  languageFail: number;
  typeFail: number;
  dvFail: number;
  noLinksFail: number;
}

/**
 * Filter releases by configured quality / audio / language / type rules and
 * sort the survivors best-first. Pure function over the release shape — no
 * source-specific knowledge.
 *
 * Lives in src/scraper/ because it operates on ScrapedRelease (the shared
 * release shape) and uses the QUALITY/AUDIO rank tables from the same
 * module. Phase 3 may relocate this when the source plugins fully detach.
 */
export function filterReleases(releases: ScrapedRelease[], mediaType: 'movie' | 'show' = 'movie'): ScrapedRelease[] {
  return filterReleasesWithStats(releases, mediaType).releases;
}

/**
 * Same as filterReleases but also returns per-axis rejection counts. Used by
 * the scheduler to log an honest failure breakdown instead of always blaming
 * "quality" when the real culprit is e.g. unresolved hoster links.
 *
 * Resolution/audio thresholds can differ per media type: when the user enables
 * `quality.series_override`, shows read the `quality.series_*` settings; movies
 * (and shows without the override) use the global `quality.*` values. Language
 * and excluded release-types stay global on purpose — they rarely differ.
 */
export function filterReleasesWithStats(releases: ScrapedRelease[], mediaType: 'movie' | 'show' = 'movie'): { releases: ScrapedRelease[]; stats: FilterStats } {
  const seriesOverride = mediaType === 'show' && getSetting('quality.series_override') === 'true';
  const p = seriesOverride ? 'quality.series_' : 'quality.';
  const minQuality = getSetting(`${p}minimum`);           // empty = "Beste verfügbare" (no min)
  const maxQuality = getSetting(`${p}maximum`);           // empty = no max
  const minAudio = getSetting(`${p}audio_minimum`);       // empty = "Beste verfügbare" (no min)
  const excludeTypes = (getSetting('quality.exclude_types') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  // Configured preferred language (default 'german'). '', 'any' or 'all' accepts
  // every language; otherwise the release must match it (or be 'unknown', i.e.
  // no language stated in the title). Stays global across movies/shows.
  const language = (getSetting('quality.language') || 'german').toLowerCase();
  const anyLanguage = language === '' || language === 'any' || language === 'all';

  // Resolve rank thresholds. Empty/unknown setting → no filter on that axis.
  const minQualityRank = minQuality ? (QUALITY_RANK[minQuality] ?? 0) : 0;
  const maxQualityRank = maxQuality ? (QUALITY_RANK[maxQuality] ?? Infinity) : Infinity;
  const minAudioRank = minAudio ? audioRank(minAudio) : 0;

  const stats: FilterStats = {
    total: releases.length,
    qualityFail: 0, audioFail: 0, languageFail: 0,
    typeFail: 0, dvFail: 0, noLinksFail: 0,
  };

  const filtered = releases.filter(r => {
    const qRank = QUALITY_RANK[r.quality] || 0;
    const aRank = audioRank(r.audio);

    const qualityOk = qRank >= minQualityRank && qRank <= maxQualityRank;
    // unknown audio = not detected in the release title; aRank === 0 = detected
    // but a codec we don't recognize. Both mean "can't judge" — don't filter
    // them out, otherwise a good-but-unrecognized track is silently dropped.
    const audioOk = r.audio === 'unknown' || aRank === 0 || aRank >= minAudioRank;
    const languageOk = anyLanguage || (r.language || '').toLowerCase() === language || r.language === 'unknown';
    const typeOk = !excludeTypes.includes(r.releaseType);
    const dvExcluded = excludeTypes.includes('dolbyvision') && r.isDolbyVision;
    const hasLinks = r.links.length > 0;

    // Tally rejection reasons per-axis. A single release can fail multiple
    // axes; that's intentional — the diagnostic shows the failure shape.
    if (!qualityOk) stats.qualityFail++;
    if (!audioOk) stats.audioFail++;
    if (!languageOk) stats.languageFail++;
    if (!typeOk) stats.typeFail++;
    if (dvExcluded) stats.dvFail++;
    if (!hasLinks) stats.noLinksFail++;

    return qualityOk && audioOk && languageOk && typeOk && !dvExcluded && hasLinks;
  });

  filtered.sort((a, b) => {
    const qDiff = (QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0);
    if (qDiff !== 0) return qDiff;
    const aDiff = audioRank(b.audio) - audioRank(a.audio);
    if (aDiff !== 0) return aDiff;
    // Final tiebreaker: at equal resolution + audio, prefer the larger file.
    // Higher bitrate (more GB) almost always means better video at the same
    // resolution — this is the only place size influences selection.
    return parseSizeToMB(b.size) - parseSizeToMB(a.size);
  });

  return { releases: filtered, stats };
}
