import { Router, Request, Response } from 'express';
import axios from 'axios';
import { getSetting } from '../../database/index';

const router = Router();

const CACHE_TTL = 24 * 60 * 60 * 1000;
const cache = new Map<string, { url: string | null; ts: number }>();

// 1x1 transparent PNG — served (200) instead of a 404 when posters can't be
// fetched (no OMDb key), so the browser doesn't log a failed request per movie
// while the frontend's gradient fallback paints behind it.
const TRANSPARENT_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function rememberLookup(imdbId: string, url: string | null) {
  cache.set(imdbId, { url, ts: Date.now() });
  if (cache.size > 1000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

/**
 * GET /api/poster/tmdb/:size/:file — poster for a TMDb-sourced catalog row.
 *
 * Seerr's search returns a TMDb `posterPath` but no IMDb id, so the OMDb route
 * below cannot serve these. Redirecting through dlvault rather than putting the
 * TMDb URL straight in the page keeps the image-src policy intact: CSP checks
 * the request's initial URL, and a redirect from same-origin is not re-checked.
 *
 * Side benefit: Seerr users get posters without configuring an OMDb key at all.
 */
const TMDB_SIZES = new Set(['w185', 'w300', 'w500', 'w780', 'original']);

router.get('/tmdb/:size/:file', (req: Request, res: Response) => {
  const size = String(req.params.size || '');
  const file = String(req.params.file || '');
  // Strict: the path segment is echoed into an outbound URL, so anything but a
  // plain TMDb image filename is refused rather than sanitised.
  if (!TMDB_SIZES.has(size) || !/^[A-Za-z0-9]+\.(jpg|png|webp)$/.test(file)) {
    res.status(400).end();
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.redirect(302, `https://image.tmdb.org/t/p/${size}/${file}`);
});

router.get('/:imdbId', async (req: Request, res: Response) => {
  const imdbId = String(req.params.imdbId || '').trim();
  if (!/^tt\d+$/i.test(imdbId)) {
    res.status(400).end();
    return;
  }

  const cached = cache.get(imdbId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    if (!cached.url) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.redirect(302, cached.url);
    return;
  }

  const apiKey = getSetting('omdb.api_key');
  if (!apiKey) {
    // No OMDb key → posters can't be fetched at all. Serve a transparent pixel
    // (200) instead of a 404 so the browser doesn't log a failed request for
    // every single movie; the frontend's gradient-and-title fallback shows
    // behind it. Not cached, so adding an OMDb key later takes effect at once.
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.end(TRANSPARENT_PIXEL);
    return;
  }

  try {
    const omdb = await axios.get('https://www.omdbapi.com/', {
      params: { apikey: apiKey, i: imdbId },
      timeout: 8000,
    });
    const poster = omdb.data?.Response === 'True' && omdb.data.Poster && omdb.data.Poster !== 'N/A'
      ? String(omdb.data.Poster)
      : null;
    rememberLookup(imdbId, poster);
    if (!poster) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.redirect(302, poster);
  } catch {
    res.status(502).end();
  }
});

export default router;
