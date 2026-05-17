import type {
  SourcePlugin,
  SearchQuery,
  ReleaseSet,
  DiscoverItem,
  PluginHealthOutcome,
  HosterLink,
  ScrapedRelease,
  TitleCandidate,
} from '../types';
import type { ReleaseType } from '../../scraper/constants';
import type { PluginContext, PluginFactory } from '../context';
import type { PluginManifest } from '../manifest';
import {
  createIAApi,
  posterUrl, fileUrl, detailUrl,
  type IAApi, type IAFile, type IASearchDoc,
} from './api';

/**
 * Internet Archive plugin — surfaces public-domain feature films from
 * archive.org (the "feature_films" collection: Night of the Living Dead,
 * Nosferatu, His Girl Friday, government and educational films, etc.).
 *
 * Bundled with dlvault as the reference plugin. Demonstrates the manifest+
 * factory pattern that external plugin authors should follow:
 *   - all I/O via the injected PluginContext (no direct axios import)
 *   - manifest is a separate named export consumed by the loader/UI
 *   - default export is a factory `(context) => SourcePlugin`
 */

export const manifest: PluginManifest = {
  id: 'internet-archive',
  name: 'Internet Archive',
  version: '1.0.0',
  mediaTypes: ['movie'],
  description: 'Public-domain feature films from archive.org. No captcha, direct downloads.',
  author: 'dlvault',
  homepage: 'https://archive.org',
  cspDomains: ['archive.org'],
};

const VIDEO_FORMAT_HINTS = [
  'mpeg4', 'h.264', 'h264', 'mp4', 'matroska', 'mkv',
  'webm', 'ogg', 'ogv', 'cinepak', 'mpeg2', 'avi',
];
const VIDEO_EXT_RE = /\.(mp4|mkv|webm|ogv|m4v|mpg|mpeg|avi)$/i;
const DISCOVER_TTL_MS = 30 * 60 * 1000;

function isVideoFile(file: IAFile): boolean {
  const fmt = (file.format || '').toLowerCase();
  if (VIDEO_FORMAT_HINTS.some(h => fmt.includes(h))) return true;
  return VIDEO_EXT_RE.test(file.name);
}

function humanSize(bytes?: string): string {
  if (!bytes) return '';
  const n = Number(bytes);
  if (!isFinite(n) || n <= 0) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function inferQuality(filename: string, sizeBytes?: string): string {
  const fn = filename.toLowerCase();
  if (fn.includes('2160p') || fn.includes('4k') || fn.includes('uhd')) return '2160p';
  if (fn.includes('1080p')) return '1080p';
  if (fn.includes('720p')) return '720p';
  if (fn.includes('480p')) return '480p';
  const n = Number(sizeBytes || 0);
  if (n > 2_000_000_000) return '1080p';
  if (n > 700_000_000) return '720p';
  return '480p';
}

function fileToRelease(identifier: string, file: IAFile): ScrapedRelease {
  const baseName = file.name.replace(/\.[^.]+$/, '');
  return {
    title: baseName,
    quality: inferQuality(file.name, file.size),
    audio: 'unknown',
    language: 'unknown',
    size: humanSize(file.size),
    releaseType: 'rip' as ReleaseType,
    isDolbyVision: false,
    season: null,
    episode: null,
    isSeasonPack: false,
    links: [{ hoster: 'archive.org', url: fileUrl(identifier, file.name) }],
  };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function pickBestMatch(docs: IASearchDoc[], query: SearchQuery): IASearchDoc | null {
  const target = normalize(query.title);
  if (!target) return null;

  if (query.year != null) {
    const wanted = query.year;
    const exactYear = docs.find(d => normalize(d.title) === target && Number(d.year) === wanted);
    if (exactYear) return exactYear;
    const nearYear = docs.find(d => normalize(d.title) === target && Math.abs(Number(d.year) - wanted) <= 1);
    if (nearYear) return nearYear;
    return null;
  }

  const exact = docs.find(d => normalize(d.title) === target);
  if (exact) return exact;

  return docs.find(d => {
    const n = normalize(d.title);
    return n.includes(target) || target.includes(n);
  }) || null;
}

function docToDiscover(d: IASearchDoc, rank: number): DiscoverItem {
  return {
    rank,
    title: d.title || d.identifier,
    year: d.year ? Number(d.year) : undefined,
    genres: Array.isArray(d.subject)
      ? d.subject.slice(0, 3)
      : d.subject
        ? [String(d.subject)]
        : [],
    poster: posterUrl(d.identifier),
    url: detailUrl(d.identifier),
    description: (d.description || '').slice(0, 300),
  };
}

const factory: PluginFactory = (context: PluginContext): SourcePlugin => {
  const api: IAApi = createIAApi(context.http, context.logger);

  // Discover cache lives in the closure so each plugin instance has its own.
  let cachedDiscover: DiscoverItem[] | null = null;
  let cachedAt = 0;

  return {
    id: manifest.id,
    name: manifest.name,
    mediaTypes: manifest.mediaTypes,
    cspDomains: manifest.cspDomains,

    async findReleases(query: SearchQuery): Promise<ReleaseSet> {
      if (query.mediaType !== 'movie') {
        return { sourceUrl: null, releases: [] };
      }
      // Restrict to the curated `feature_films` collection so we don't match
      // random user uploads in the default `opensource_movies` bucket
      // (where uploaders spam new-release titles for clicks).
      const docs = await api.search({
        q: query.title,
        year: query.year,
        collection: 'feature_films',
        rows: 20,
      });
      if (docs.length === 0) return { sourceUrl: null, releases: [] };

      const best = pickBestMatch(docs, query);
      if (!best) return { sourceUrl: null, releases: [] };

      const meta = await api.metadata(best.identifier);
      if (!meta) {
        return { sourceUrl: detailUrl(best.identifier), releases: [] };
      }

      const videoFiles = meta.files.filter(isVideoFile);
      const releases = videoFiles.map(f => fileToRelease(best.identifier, f));

      return { sourceUrl: detailUrl(best.identifier), releases };
    },

    async resolveLinks(links: HosterLink[]): Promise<HosterLink[]> {
      return links;
    },

    async searchTitles(query: string, opts): Promise<TitleCandidate[]> {
      if (opts?.mediaType === 'show') return [];
      // Same curation filter as findReleases — only feature_films, not user uploads.
      const docs = await api.search({ q: query, collection: 'feature_films', rows: opts?.limit ?? 5 });
      return docs.slice(0, opts?.limit ?? 5).map(d => ({
        title: d.title || d.identifier,
        year: d.year ? Number(d.year) : undefined,
        poster: posterUrl(d.identifier),
        url: detailUrl(d.identifier),
      }));
    },

    async discover(): Promise<DiscoverItem[]> {
      if (cachedDiscover && Date.now() - cachedAt < DISCOVER_TTL_MS) {
        return cachedDiscover;
      }
      const docs = await api.search({
        collection: 'feature_films',
        rows: 10,
        sort: '-downloads',
      });
      if (docs.length === 0) {
        context.logger.warn('discover returned no results');
        return cachedDiscover || [];
      }
      cachedDiscover = docs.map((d, i) => docToDiscover(d, i + 1));
      cachedAt = Date.now();
      return cachedDiscover;
    },

    getCachedDiscover(): DiscoverItem[] | null {
      if (cachedDiscover && Date.now() - cachedAt < DISCOVER_TTL_MS) {
        return cachedDiscover;
      }
      return null;
    },

    async healthCheck(): Promise<PluginHealthOutcome> {
      // "Night of the Living Dead" (1968) — distributed without a copyright
      // notice in the US, became public domain. On archive.org for decades.
      try {
        const docs = await api.search({ q: 'Night of the Living Dead', year: 1968, rows: 1 });
        if (docs.length === 0) {
          return { ok: false, critical: false, error: 'IA sentinel returned no results' };
        }
        return { ok: true, critical: false, detail: docs[0].identifier };
      } catch (err: any) {
        return { ok: false, critical: false, error: err?.message || String(err) };
      }
    },
  };
};

export default factory;
