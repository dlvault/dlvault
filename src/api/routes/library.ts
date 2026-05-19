import { Router, Request, Response } from 'express';
import axios from 'axios';
import { getSetting } from '../../database/index';
import { getLibraryProvider, getLibraryProviderType, getLibraryProviderName } from '../../services/libraryProvider';
import type { LibraryMovie } from '../../services/libraryProvider';
import { getAllMovies, updateMovieStatus, Movie } from '../../database/services/movies';
import { addLogEntry } from '../../database/services/activityLog';
import { logger } from '../../utils/logger';

const router = Router();

// GET /api/library
router.get('/', async (req: Request, res: Response) => {
  const type = req.query.type as string || 'all';
  if (!['all', 'movie', 'show'].includes(type)) {
    res.status(400).json({ error: 'Invalid type parameter' });
    return;
  }

  try {
    const provider = getLibraryProvider();
    const providerType = getLibraryProviderType();
    const movies = await provider.getMovies(true);

    const items = movies
      .filter(m => type === 'all' || m.mediaType === type)
      .map(m => ({
        ...m,
        posterUrl: m.imageTag ? `/api/library/${m.id}/poster?tag=${m.imageTag}` : null,
      }));

    res.json({
      items,
      total: items.length,
      source: provider.isConfigured() ? providerType : 'none',
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load library' });
  }
});

// GET /api/library/:id/poster — proxy poster images (hides API key/token).
// `id` is a Plex/Jellyfin item identifier; `tag` is either a Plex thumb path
// (`/library/metadata/.../thumb/...`) or an opaque Jellyfin image hash.
// Restrict both to a conservative character set so they can't smuggle
// path-segment escapes or absolute URLs into the upstream request.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PLEX_THUMB_RE = /^\/library\/metadata\/[A-Za-z0-9_/.-]{1,128}$/;
const JELLYFIN_TAG_RE = /^[A-Za-z0-9]{1,64}$/;

router.get('/:id/poster', async (req: Request, res: Response) => {
  const providerType = getLibraryProviderType();

  const id = String(req.params.id);
  if (!ID_RE.test(id)) { res.status(400).end(); return; }

  try {
    let imageUrl: string;
    let headers: Record<string, string>;

    if (providerType === 'plex') {
      const serverUrl = (getSetting('plex.server_url') || '').replace(/\/+$/, '');
      const token = getSetting('plex.token') || '';
      if (!serverUrl || !token) { res.status(404).end(); return; }

      const thumb = String(req.query.tag || '');
      if (thumb.startsWith('/')) {
        if (!PLEX_THUMB_RE.test(thumb)) { res.status(400).end(); return; }
        imageUrl = `${serverUrl}${thumb}`;
      } else {
        imageUrl = `${serverUrl}/library/metadata/${id}/thumb`;
      }
      headers = { 'X-Plex-Token': token };
    } else {
      const jellyfinUrl = (getSetting('jellyfin.url') || '').replace(/\/+$/, '');
      const apiKey = getSetting('jellyfin.api_key') || '';
      if (!jellyfinUrl || !apiKey) { res.status(404).end(); return; }

      const tag = String(req.query.tag || '');
      if (tag && !JELLYFIN_TAG_RE.test(tag)) { res.status(400).end(); return; }
      const tagParam = new URLSearchParams({ maxHeight: '300', tag });
      imageUrl = `${jellyfinUrl}/Items/${id}/Images/Primary?${tagParam.toString()}`;
      headers = { 'X-Emby-Token': apiKey };
    }

    const response = await axios.get(imageUrl, {
      headers,
      responseType: 'arraybuffer',
      timeout: 10000,
    });
    const tag = String(req.query.tag || '');
    res.setHeader('Content-Type', String(response.headers['content-type'] || 'image/jpeg'));
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    if (tag) res.setHeader('ETag', `"${tag}"`);
    res.send(response.data);
  } catch {
    res.status(404).end();
  }
});

// DELETE /api/library/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id || typeof id !== 'string' || id.length > 64) {
      res.status(400).json({ error: 'Invalid item ID' });
      return;
    }
    const provider = getLibraryProvider();
    const success = await provider.deleteItem(id);
    if (success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Delete failed' });
    }
  } catch (error: any) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Helper: find matching movie in database for a library item
function findMatchingMovie(libraryItem: LibraryMovie, movies: Movie[]): Movie | undefined {
  if (libraryItem.imdbId) {
    const match = movies.find(m => m.imdb_id === libraryItem.imdbId);
    if (match) return match;
  }

  if (libraryItem.tmdbId) {
    const tmdbNum = parseInt(libraryItem.tmdbId, 10);
    if (!isNaN(tmdbNum)) {
      const match = movies.find(m => m.tmdb_id === tmdbNum);
      if (match) return match;
    }
  }

  if (libraryItem.name && libraryItem.year) {
    const normalizedName = libraryItem.name.toLowerCase().trim();
    const match = movies.find(
      m => m.title.toLowerCase().trim() === normalizedName && m.year === libraryItem.year
    );
    if (match) return match;
  }

  return undefined;
}

// POST /api/library/import — scan library and mark matching movies as downloaded
router.post('/import', async (_req: Request, res: Response) => {
  try {
    const provider = getLibraryProvider();
    const providerName = getLibraryProviderName();
    if (!provider.isConfigured()) {
      res.status(400).json({ error: `${providerName} is not configured` });
      return;
    }

    const libraryMovies = await provider.getMovies(true);
    const dbMovies = getAllMovies();

    let imported = 0;
    let alreadyImported = 0;
    let noMatch = 0;

    for (const libMovie of libraryMovies) {
      const match = findMatchingMovie(libMovie, dbMovies);

      if (!match) {
        noMatch++;
        continue;
      }

      if (match.status === 'downloaded') {
        alreadyImported++;
        continue;
      }

      updateMovieStatus(match.id, 'downloaded');
      addLogEntry(match.id, 'library_import', `Marked as downloaded (found in ${providerName}: "${libMovie.name}")`);
      imported++;
    }

    res.json({ imported, alreadyImported, noMatch });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Library import failed: ${message}`);
    res.status(500).json({ error: 'Library import failed' });
  }
});

// POST /api/library/scan — dry run: check how many matches would be found
router.post('/scan', async (_req: Request, res: Response) => {
  try {
    const provider = getLibraryProvider();
    const providerName = getLibraryProviderName();
    if (!provider.isConfigured()) {
      res.status(400).json({ error: `${providerName} is not configured` });
      return;
    }

    const libraryMovies = await provider.getMovies(true);
    const dbMovies = getAllMovies();

    let imported = 0;
    let alreadyImported = 0;
    let noMatch = 0;

    for (const libMovie of libraryMovies) {
      const match = findMatchingMovie(libMovie, dbMovies);

      if (!match) {
        noMatch++;
        continue;
      }

      if (match.status === 'downloaded') {
        alreadyImported++;
      } else {
        imported++;
      }
    }

    res.json({ imported, alreadyImported, noMatch });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Library scan failed: ${message}`);
    res.status(500).json({ error: 'Library scan failed' });
  }
});

export default router;
