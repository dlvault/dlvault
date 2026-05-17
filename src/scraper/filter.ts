import { getSetting } from '../database/index';
import { QUALITY_RANK, AUDIO_RANK, type ScrapedRelease } from './constants';

/**
 * Filter releases by configured quality / audio / language / type rules and
 * sort the survivors best-first. Pure function over the release shape — no
 * source-specific knowledge.
 *
 * Lives in src/scraper/ because it operates on ScrapedRelease (the shared
 * release shape) and uses the QUALITY/AUDIO rank tables from the same
 * module. Phase 3 may relocate this when the source plugins fully detach.
 */
export function filterReleases(releases: ScrapedRelease[]): ScrapedRelease[] {
  const minQuality = getSetting('quality.minimum');       // empty = "Beste verfügbare" (no min)
  const maxQuality = getSetting('quality.maximum');       // empty = no max
  const minAudio = getSetting('quality.audio_minimum');   // empty = "Beste verfügbare" (no min)
  const excludeTypes = (getSetting('quality.exclude_types') || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  // Resolve rank thresholds. Empty/unknown setting → no filter on that axis.
  const minQualityRank = minQuality ? (QUALITY_RANK[minQuality] ?? 0) : 0;
  const maxQualityRank = maxQuality ? (QUALITY_RANK[maxQuality] ?? Infinity) : Infinity;
  const minAudioRank = minAudio ? (AUDIO_RANK[minAudio] ?? 0) : 0;

  const filtered = releases.filter(r => {
    const qRank = QUALITY_RANK[r.quality] || 0;
    const aRank = AUDIO_RANK[r.audio] || 0;

    const qualityOk = qRank >= minQualityRank && qRank <= maxQualityRank;
    // unknown audio = audio not in release title, don't filter out (we just don't know)
    const audioOk = r.audio === 'unknown' || aRank >= minAudioRank;
    const languageOk = r.language === 'german' || r.language === 'unknown';
    const typeOk = !excludeTypes.includes(r.releaseType);
    const dvExcluded = excludeTypes.includes('dolbyvision') && r.isDolbyVision;
    const hasLinks = r.links.length > 0;

    return qualityOk && audioOk && languageOk && typeOk && !dvExcluded && hasLinks;
  });

  filtered.sort((a, b) => {
    const qDiff = (QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0);
    if (qDiff !== 0) return qDiff;
    return (AUDIO_RANK[b.audio] || 0) - (AUDIO_RANK[a.audio] || 0);
  });

  return filtered;
}
