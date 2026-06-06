import { getSetting } from '../database/index';
import { QUALITY_RANK, audioRank, parseSizeToMB, type ScrapedRelease } from './constants';
import type { QualityOverride } from '../database/services/movies';

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
export function filterReleases(releases: ScrapedRelease[], mediaType: 'movie' | 'show' = 'movie', override: QualityOverride | null = null): ScrapedRelease[] {
  return filterReleasesWithStats(releases, mediaType, override).releases;
}

/**
 * All thresholds resolved from settings (+ per-title override) for one filter
 * run. Built once via buildFilterContext, then applied per release — both by
 * the bulk filter below and by releaseRejectionReasons for per-release
 * verdicts, so the rules can't drift apart.
 */
export interface FilterContext {
  minQualityRank: number;
  maxQualityRank: number;
  minAudioRank: number;
  excludeTypes: string[];
  language: string;
  anyLanguage: boolean;
  strictLanguage: boolean;
  // Original setting strings, kept for human-readable rejection messages.
  minQuality: string;
  maxQuality: string;
  minAudio: string;
}

/**
 * Resolution/audio thresholds can differ per media type: when the user enables
 * `quality.series_override`, shows read the `quality.series_*` settings; movies
 * (and shows without the override) use the global `quality.*` values. Language
 * and excluded release-types stay global on purpose — they rarely differ.
 */
export function buildFilterContext(mediaType: 'movie' | 'show' = 'movie', override: QualityOverride | null = null): FilterContext {
  const seriesOverride = mediaType === 'show' && getSetting('quality.series_override') === 'true';
  const p = seriesOverride ? 'quality.series_' : 'quality.';
  const minQuality = getSetting(`${p}minimum`) || '';     // empty = "Beste verfügbare" (no min)
  const maxQuality = getSetting(`${p}maximum`) || '';     // empty = no max
  const minAudio = getSetting(`${p}audio_minimum`) || ''; // empty = "Beste verfügbare" (no min)
  let excludeTypes = (getSetting('quality.exclude_types') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  // Configured preferred language (default 'german'). '', 'any' or 'all' accepts
  // every language; otherwise the release must match it (or be 'unknown', i.e.
  // no language stated in the title). Stays global across movies/shows.
  const language = (getSetting('quality.language') || 'german').toLowerCase();
  let anyLanguage = language === '' || language === 'any' || language === 'all';

  // Resolve rank thresholds. Empty/unknown setting → no filter on that axis.
  let minQualityRank = minQuality ? (QUALITY_RANK[minQuality] ?? 0) : 0;
  let maxQualityRank = maxQuality ? (QUALITY_RANK[maxQuality] ?? Infinity) : Infinity;
  let minAudioRank = minAudio ? audioRank(minAudio) : 0;

  // Per-title override (movies.quality_override): the user explicitly wants this
  // title even though nothing passes the configured floor. 'relaxed' drops the
  // minimum thresholds and type exclusions but keeps the language requirement and
  // the upper resolution cap — "best version in my language". 'any' accepts every
  // release that has links, foreign languages included. The best-first sort is
  // unchanged, so a conforming release always wins over a relaxed-only one.
  if (override === 'relaxed' || override === 'any') {
    minQualityRank = 0;
    minAudioRank = 0;
    excludeTypes = [];
  }
  if (override === 'any') {
    anyLanguage = true;
    maxQualityRank = Infinity;
  }

  // Strict mode (opt-in): an unstated ('unknown') language no longer passes — only
  // an exact match. Lets a German-preference setup wait for a real German release
  // instead of grabbing an unmarked/foreign one (e.g. an English-only season pack
  // whose title carries no language token). Moot when anyLanguage.
  const strictLanguage = !anyLanguage && getSetting('quality.language_strict') === 'true';

  return {
    minQualityRank, maxQualityRank, minAudioRank,
    excludeTypes, language, anyLanguage, strictLanguage,
    minQuality, maxQuality, minAudio,
  };
}

/** Per-axis pass/fail for one release against a resolved context. */
interface AxisVerdict {
  qualityOk: boolean;
  audioOk: boolean;
  languageOk: boolean;
  typeOk: boolean;
  dvExcluded: boolean;
  hasLinks: boolean;
}

function judgeRelease(r: ScrapedRelease, ctx: FilterContext): AxisVerdict {
  const qRank = QUALITY_RANK[r.quality] || 0;
  const aRank = audioRank(r.audio);
  return {
    qualityOk: qRank >= ctx.minQualityRank && qRank <= ctx.maxQualityRank,
    // unknown audio = not detected in the release title; aRank === 0 = detected
    // but a codec we don't recognize. Both mean "can't judge" — don't filter
    // them out, otherwise a good-but-unrecognized track is silently dropped.
    audioOk: r.audio === 'unknown' || aRank === 0 || aRank >= ctx.minAudioRank,
    languageOk: ctx.anyLanguage
      || (r.language || '').toLowerCase() === ctx.language
      || (!ctx.strictLanguage && r.language === 'unknown'),
    typeOk: !ctx.excludeTypes.includes(r.releaseType),
    dvExcluded: ctx.excludeTypes.includes('dolbyvision') && r.isDolbyVision,
    hasLinks: r.links.length > 0,
  };
}

// User-facing names for the common language tokens; unknown tokens pass through.
const LANGUAGE_LABEL: Record<string, string> = {
  german: 'Deutsch', english: 'Englisch', french: 'Französisch',
  spanish: 'Spanisch', italian: 'Italienisch',
};

/**
 * Human-readable German reasons why one release fails the configured filters.
 * Empty array = release passes. Used by /api/search to annotate the release
 * picker and by the candidates list in the detail panel — the user finally
 * sees *why* a specific release was rejected, not just an aggregate count.
 */
export function releaseRejectionReasons(r: ScrapedRelease, ctx: FilterContext): string[] {
  const v = judgeRelease(r, ctx);
  const reasons: string[] = [];
  const q = r.quality === 'unknown' || !r.quality ? 'unbekannt' : r.quality;

  if (!v.qualityOk) {
    const qRank = QUALITY_RANK[r.quality] || 0;
    if (qRank > ctx.maxQualityRank) reasons.push(`Auflösung über Maximum (${q}, max. ${ctx.maxQuality})`);
    else reasons.push(`Auflösung unter Minimum (${q}, min. ${ctx.minQuality})`);
  }
  if (!v.audioOk) reasons.push(`Audio unter Minimum (${r.audio}, min. ${ctx.minAudio})`);
  if (!v.languageOk) {
    const wanted = LANGUAGE_LABEL[ctx.language] || ctx.language;
    reasons.push(r.language === 'unknown'
      ? `Sprache im Titel nicht erkennbar (strikt: nur ${wanted})`
      : `Falsche Sprache (${LANGUAGE_LABEL[(r.language || '').toLowerCase()] || r.language}, gewünscht ${wanted})`);
  }
  if (!v.typeOk) reasons.push(`Release-Typ ausgeschlossen (${r.releaseType})`);
  if (v.dvExcluded) reasons.push('Dolby Vision ausgeschlossen');
  if (!v.hasLinks) reasons.push('Keine nutzbaren Hoster-Links');
  return reasons;
}

/**
 * Same as filterReleases but also returns per-axis rejection counts. Used by
 * the scheduler to log an honest failure breakdown instead of always blaming
 * "quality" when the real culprit is e.g. unresolved hoster links.
 */
export function filterReleasesWithStats(releases: ScrapedRelease[], mediaType: 'movie' | 'show' = 'movie', override: QualityOverride | null = null): { releases: ScrapedRelease[]; stats: FilterStats } {
  const ctx = buildFilterContext(mediaType, override);

  const stats: FilterStats = {
    total: releases.length,
    qualityFail: 0, audioFail: 0, languageFail: 0,
    typeFail: 0, dvFail: 0, noLinksFail: 0,
  };

  const filtered = releases.filter(r => {
    const v = judgeRelease(r, ctx);

    // Tally rejection reasons per-axis. A single release can fail multiple
    // axes; that's intentional — the diagnostic shows the failure shape.
    if (!v.qualityOk) stats.qualityFail++;
    if (!v.audioOk) stats.audioFail++;
    if (!v.languageOk) stats.languageFail++;
    if (!v.typeOk) stats.typeFail++;
    if (v.dvExcluded) stats.dvFail++;
    if (!v.hasLinks) stats.noLinksFail++;

    return v.qualityOk && v.audioOk && v.languageOk && v.typeOk && !v.dvExcluded && v.hasLinks;
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
