import { Router, Request, Response } from 'express';
import { pluginRegistry } from '../../plugins/registry';
import { withPluginTimeout, PLUGIN_TIMEOUTS } from '../../plugins/timeout';
import type { HosterLink } from '../../plugins/types';
import { jdownloaderService } from '../../jdownloader/index';
import { addMovie, getMovieByImdbId, getMovieByTmdbId, updateMovieStatus } from '../../database/services/movies';
import { addDownload, updateDownloadStatusByMovieId } from '../../database/services/downloads';
import { addLogEntry } from '../../database/services/activityLog';
import { buildFilterContext, releaseRejectionReasons } from '../../scraper/filter';
import { eventBus } from '../../services/eventbus';
import { traktService } from '../../services/trakt';
import { plexService } from '../../services/plex';
import { seerrService } from '../../services/seerr';
import { tmdbService } from '../../services/tmdb';
import { getSetting } from '../../database/index';
import { logger } from '../../utils/logger';

const router = Router();

/** TMDb path first (no OMDb key needed), IMDb second, nothing otherwise. */
function posterFor(m: { imdbId?: string | null; posterPath?: string | null }): string | null {
  if (m.posterPath) return `/api/poster/tmdb/w500${m.posterPath}`;
  if (m.imdbId) return `/api/poster/${m.imdbId}`;
  return null;
}

/**
 * Drop entries that a plugin returned with a missing/empty hoster or url —
 * otherwise they land in the downloads table as junk rows.
 */
function validateHosterLinks(links: HosterLink[], pluginId: string): HosterLink[] {
  return links.filter(l => {
    const ok = !!l
      && typeof l.hoster === 'string' && l.hoster.length > 0
      && typeof l.url === 'string' && l.url.length > 0;
    if (!ok) {
      logger.warn(`Plugin "${pluginId}" returned malformed HosterLink, dropping: ${JSON.stringify(l)}`);
    }
    return ok;
  });
}

/**
 * Walk registered plugins, letting each refine the link list via its own
 * resolveLinks contract. Plugins that have nothing to do return the input
 * unchanged. The final array reflects the cumulative refinement.
 */
async function resolveViaRegistry(links: HosterLink[]): Promise<HosterLink[]> {
  let current = links;
  for (const plugin of pluginRegistry.getAll()) {
    try {
      current = validateHosterLinks(await withPluginTimeout('resolveLinks', PLUGIN_TIMEOUTS.resolveLinks, plugin.resolveLinks(current)), plugin.id);
    } catch (err: any) {
      logger.debug(`Manual resolve: plugin "${plugin.id}" failed: ${err?.message || err}`);
    }
  }
  return current;
}

// GET /api/search/all?q=... — unified search for the full-page centralized
// search, grouped by media type.
//
// Movies/shows come from Trakt's CATALOG (clean metadata: title, year, ids,
// poster via the OMDb proxy) — NOT from release-source plugins, so the host UI
// never surfaces those. The plugins still do the actual downloading behind the
// scenes (via the pipeline) once a title is added. Music comes from the music
// plugin (no neutral catalog equivalent exists).
router.get('/all', async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    res.status(400).json({ error: 'query param "q" is required' });
    return;
  }
  const limit = Math.min(Number(req.query.limit) || 12, 30);

  try {
    // Catalog source follows the watchlist provider: Seerr proxies TMDb (and is
    // the only one still working since Trakt closed its API), a Plex-only
    // instance searches Plex Discover, everyone else uses Trakt.
    const provider = getSetting('watchlist.provider') || 'trakt';
    // TMDb first when a key is present: it is the same data Seerr proxies, one
    // step shorter, and it works regardless of which watchlist provider runs.
    const useTmdb = tmdbService.isConfigured();
    const useSeerrCatalog = !useTmdb && provider === 'seerr' && seerrService.isConfigured();
    const usePlexCatalog = !useTmdb && provider === 'plex' && plexService.isConfigured();
    const catalogOpts = { types: ['movie', 'show'] as ('movie' | 'show')[], limit: Math.max(limit * 2, 24) };
    const [catalog, music] = await Promise.all([
      useTmdb ? tmdbService.searchCatalog(q, catalogOpts)
        : useSeerrCatalog ? seerrService.searchCatalog(q, catalogOpts)
        : usePlexCatalog ? plexService.searchCatalog(q, catalogOpts)
        : traktService.searchCatalog(q, catalogOpts),
      // Music returns albums + tracks in one bucket — surface ALL of them (the
      // UI splits into "Alben" / "Songs"). High cap = effectively everything the
      // source returns.
      pluginRegistry.aggregateSearchTitles(q, { mediaType: 'music', limit: 100 }),
    ]);
    const movies = catalog.filter(c => c.type === 'movie');
    const shows = catalog.filter(c => c.type === 'show');

    const catalogCandidate = (
      m: { title: string; year: number | null; imdbId: string | null; tmdbId: number | null; posterPath?: string | null },
      mediaType: 'movie' | 'show',
    ) => ({
      title: m.title,
      year: m.year ?? undefined,
      imdbId: m.imdbId ?? undefined,
      tmdbId: m.tmdbId ?? undefined,
      // A TMDb path needs no OMDb key and no IMDb id, so prefer it when present.
      poster: posterFor(m),
      mediaType,
    });

    const groups = [
      { mediaType: 'movie' as const, results: movies.map(m => catalogCandidate(m, 'movie')) },
      { mediaType: 'show' as const, results: shows.map(m => catalogCandidate(m, 'show')) },
      { mediaType: 'music' as const, results: music.map(h => ({ ...h, mediaType: 'music' as const })) },
    ].filter(g => g.results.length > 0);

    res.json({ query: q, groups });
  } catch (err: any) {
    logger.error(`Unified search error for "${q}": ${err?.message || err}`);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/search/trending — "Beliebt diese Woche" for the search page's
// discovery shelf (shown before a query). Trakt trending movies + shows,
// cached ~30 min (trending changes slowly; keeps Trakt load minimal).
let trendingCache: { at: number; items: unknown[] } | null = null;
const TRENDING_TTL = 30 * 60 * 1000;
router.get('/trending', async (_req: Request, res: Response) => {
  try {
    if (trendingCache && Date.now() - trendingCache.at < TRENDING_TTL) {
      res.json({ items: trendingCache.items });
      return;
    }
    const provider = getSetting('watchlist.provider') || 'trakt';
    const trendingOpts = { types: ['movie', 'show'] as ('movie' | 'show')[], limit: 9 };
    const raw = tmdbService.isConfigured()
      ? await tmdbService.getTrending(trendingOpts)
      : provider === 'seerr' && seerrService.isConfigured()
        ? await seerrService.getTrending(trendingOpts)
        : provider === 'plex' && plexService.isConfigured()
          ? await plexService.getTrending(trendingOpts)
          : await traktService.getTrending(trendingOpts);
    const items = raw.map(m => ({
      title: m.title,
      year: m.year ?? undefined,
      imdbId: m.imdbId ?? undefined,
      tmdbId: m.tmdbId ?? undefined,
      mediaType: m.type,
      poster: posterFor(m),
    }));
    trendingCache = { at: Date.now(), items };
    res.json({ items });
  } catch (err: any) {
    logger.error(`Trending failed: ${err?.message || err}`);
    res.status(500).json({ error: 'Trending failed' });
  }
});

// POST /api/search — manual title search across registered plugins
router.post('/', async (req: Request, res: Response) => {
  const { query, year, mediaType, qualityOverride } = req.body as {
    query?: string;
    year?: number;
    mediaType?: 'movie' | 'show';
    /** Per-title override of the caller's movie, so verdicts match its effective filter. */
    qualityOverride?: string | null;
  };

  if (!query || !query.trim()) {
    res.status(400).json({ error: 'query is required' });
    return;
  }

  const type = mediaType || 'movie';

  try {
    let sourceUrl: string | null = null;
    let scraped: import('../../plugins/types').ScrapedRelease[] = [];
    for (const plugin of pluginRegistry.forMediaType(type)) {
      try {
        const result = await withPluginTimeout('findReleases', PLUGIN_TIMEOUTS.findReleases, plugin.findReleases(
          { title: query.trim(), year, mediaType: type },
          { skipLinkResolution: true },
        ));
        if (result.sourceUrl && !sourceUrl) sourceUrl = result.sourceUrl;
        if (result.releases.length > 0) {
          scraped = result.releases;
          break;
        }
      } catch (err: any) {
        logger.debug(`/api/search: plugin "${plugin.id}" failed: ${err?.message || err}`);
      }
    }

    // Annotate every release with its filter verdict (empty = passes). Purely
    // informational — the user may still pick a rejected release manually.
    const override = qualityOverride === 'relaxed' || qualityOverride === 'any' ? qualityOverride : null;
    const filterCtx = buildFilterContext(type, override);
    const releases = scraped.map((r, index) => ({
      index,
      title: r.title,
      quality: r.quality,
      audio: r.audio,
      language: r.language,
      size: r.size,
      releaseType: r.releaseType,
      links: r.links,
      rejectionReasons: releaseRejectionReasons(r, filterCtx),
    }));

    res.json({
      sourceUrl: sourceUrl || null,
      releases,
    });
  } catch (err: any) {
    logger.error(`Search error for "${query}":`, err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// POST /api/search/download — add movie + send selected release to JDownloader
router.post('/download', async (req: Request, res: Response) => {
  const { title, year, mediaType, tmdbId, imdbId, links } = req.body as {
    title?: string;
    year?: number;
    mediaType?: 'movie' | 'show';
    tmdbId?: number;
    imdbId?: string;
    releaseIndex?: number;
    links?: { hoster: string; url: string }[];
  };

  if (!title) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  if (!Array.isArray(links) || links.length === 0) {
    res.status(400).json({ error: 'links are required' });
    return;
  }
  if (links.length > 100) {
    res.status(400).json({ error: 'Maximum 100 links allowed' });
    return;
  }
  for (const link of links) {
    if (!link.url || typeof link.url !== 'string') {
      res.status(400).json({ error: 'Each link must have a valid url' });
      return;
    }
    try { new URL(link.url); } catch {
      res.status(400).json({ error: `Invalid URL: ${link.url.substring(0, 50)}` });
      return;
    }
  }

  try {
    // Check if movie already exists (by imdb_id or tmdb_id)
    let movie = imdbId ? getMovieByImdbId(imdbId) : undefined;

    if (!movie && tmdbId) {
      // Media-type scoped — TMDb's movie and TV id spaces overlap.
      movie = getMovieByTmdbId(tmdbId, mediaType === 'show' ? 'show' : 'movie');
    }

    if (!movie) {
      movie = addMovie({
        trakt_id: null as any,
        watchlist_source: 'manual',
        imdb_id: imdbId || null,
        tmdb_id: tmdbId || null,
        title,
        year: year || null,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        media_type: mediaType || 'movie',
        status: 'found',
        desired_quality: '1080p',
      });
    } else if (movie.status !== 'downloaded' && movie.status !== 'downloading') {
      // Existing record (e.g. from Trakt sync) may be stuck in 'searching' or 'pending' —
      // a manual queue action means we have a release in hand, so promote to 'found'.
      updateMovieStatus(movie.id, 'found');
      movie.status = 'found';
      eventBus.emit('movie:updated', { id: movie.id, title: movie.title, status: 'found' });
    }

    if (!movie) {
      res.status(500).json({ error: 'Failed to create movie record' });
      return;
    }

    // Block download if already downloaded / in library
    if (movie.status === 'downloaded') {
      logger.info(`Manual download blocked — "${title}" is already downloaded`);
      res.json({ success: false, movie, warning: `"${title}" is already in your library` });
      return;
    }

    // Respond immediately — resolve links + JDownloader in background.
    // This prevents the frontend from timing out on slow link resolution.
    res.json({ success: true, movie, status: 'queued' });

    // ── Background: resolve, save, and send to JDownloader ──
    const movieId = movie.id;
    const packageName = year ? `${title} (${year})` : title;

    setImmediate(async () => {
      try {
        const resolvedLinks = await resolveViaRegistry(links!);

        if (resolvedLinks.length === 0) {
          addLogEntry(movieId, 'jdownloader_failed', 'Link resolution failed — no direct links extracted');
          logger.warn(`Download background: no resolved links for "${title}"`);
          updateMovieStatus(movieId, 'pending');
          eventBus.emit('movie:updated', { id: movieId, title: title!, status: 'pending' });
          return;
        }

        // Add download entries for each resolved link
        const linkUrls: string[] = [];
        for (const link of resolvedLinks) {
          addDownload({
            movie_id: movieId,
            release_name: title!,
            quality: undefined,
            audio: undefined,
            hoster: link.hoster,
            download_url: link.url,
          });
          linkUrls.push(link.url);
          logger.info(`Download added for ${title}: ${link.hoster}`);
        }

        // Send to JDownloader
        if (jdownloaderService.isConfigured()) {
          const sent = await jdownloaderService.addLinks(linkUrls, packageName);
          if (sent === 'sent') {
            updateMovieStatus(movieId, 'downloading');
            updateDownloadStatusByMovieId(movieId, 'sent_to_jd');
            addLogEntry(movieId, 'sent_to_jdownloader', `Manual search: sent ${linkUrls.length} link(s)`);
            logger.info(`Sent ${linkUrls.length} links to JDownloader for: ${title}`);
            eventBus.emit('movie:updated', { id: movieId, title: title!, status: 'downloading' });
          } else if (sent === 'offline') {
            // Pre-download guard found the chosen release entirely dead. Don't
            // blocklist here — in the manual path the "release name" is just the
            // movie title, so a blocklist would ban every release of the film.
            addLogEntry(movieId, 'links_offline', 'Manuelle Suche: alle Links offline beim Hoster');
            logger.warn(`Manual search: all links offline at hoster for: ${title}`);
            updateMovieStatus(movieId, 'pending');
            eventBus.emit('movie:updated', { id: movieId, title: title!, status: 'pending' });
          } else {
            addLogEntry(movieId, 'jdownloader_failed', 'Failed to send links to JDownloader');
            logger.warn(`Failed to send links to JDownloader for: ${title}`);
            updateMovieStatus(movieId, 'pending');
            eventBus.emit('movie:updated', { id: movieId, title: title!, status: 'pending' });
          }
        }
      } catch (err: any) {
        logger.error(`Download background error for "${title}": ${err.message}`);
        addLogEntry(movieId, 'jdownloader_failed', `Background error: ${err.message}`);
        updateMovieStatus(movieId, 'pending');
        eventBus.emit('movie:updated', { id: movieId, title: title!, status: 'pending' });
      }
    });
  } catch (err: any) {
    logger.error(`Download error for "${title}":`, err.message);
    res.status(500).json({ error: 'Download failed' });
  }
});

export default router;
