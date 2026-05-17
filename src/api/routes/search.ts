import { Router, Request, Response } from 'express';
import { pluginRegistry } from '../../plugins/registry';
import type { HosterLink } from '../../plugins/types';
import { jdownloaderService } from '../../jdownloader/index';
import { addMovie, getMovieByImdbId, getMovieByTmdbId, updateMovieStatus } from '../../database/services/movies';
import { addDownload, updateDownloadStatusByMovieId } from '../../database/services/downloads';
import { addLogEntry } from '../../database/services/activityLog';
import { eventBus } from '../../services/eventbus';
import { logger } from '../../utils/logger';

const router = Router();

/**
 * Walk registered plugins, letting each refine the link list via its own
 * resolveLinks contract. Plugins that have nothing to do return the input
 * unchanged. The final array reflects the cumulative refinement.
 */
async function resolveViaRegistry(links: HosterLink[]): Promise<HosterLink[]> {
  let current = links;
  for (const plugin of pluginRegistry.getAll()) {
    try {
      current = await plugin.resolveLinks(current);
    } catch (err: any) {
      logger.debug(`Manual resolve: plugin "${plugin.id}" failed: ${err?.message || err}`);
    }
  }
  return current;
}

// POST /api/search — manual title search across registered plugins
router.post('/', async (req: Request, res: Response) => {
  const { query, year, mediaType } = req.body as {
    query?: string;
    year?: number;
    mediaType?: 'movie' | 'show';
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
        const result = await plugin.findReleases(
          { title: query.trim(), year, mediaType: type },
          { skipLinkResolution: true },
        );
        if (result.sourceUrl && !sourceUrl) sourceUrl = result.sourceUrl;
        if (result.releases.length > 0) {
          scraped = result.releases;
          break;
        }
      } catch (err: any) {
        logger.debug(`/api/search: plugin "${plugin.id}" failed: ${err?.message || err}`);
      }
    }

    const releases = scraped.map((r, index) => ({
      index,
      title: r.title,
      quality: r.quality,
      audio: r.audio,
      language: r.language,
      size: r.size,
      releaseType: r.releaseType,
      links: r.links,
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
      movie = getMovieByTmdbId(tmdbId);
    }

    if (!movie) {
      movie = addMovie({
        trakt_id: null as any,
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
          if (sent) {
            updateMovieStatus(movieId, 'downloading');
            updateDownloadStatusByMovieId(movieId, 'sent_to_jd');
            addLogEntry(movieId, 'sent_to_jdownloader', `Manual search: sent ${linkUrls.length} link(s)`);
            logger.info(`Sent ${linkUrls.length} links to JDownloader for: ${title}`);
            eventBus.emit('movie:updated', { id: movieId, title: title!, status: 'downloading' });
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
