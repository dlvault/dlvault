import { Router, Request, Response } from 'express';
import axios from 'axios';
import { getSetting } from '../../database/index';
import { pluginRegistry } from '../../plugins/registry';

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
 * below cannot serve these. The redirect target still has to be in the page's
 * img-src (CSP checks every hop) — server.ts lists image.tmdb.org for that.
 *
 * Side benefit: Seerr users get posters without configuring an OMDb key at all.
 */
const TMDB_SIZES = new Set(['w185', 'w300', 'w500', 'w780', 'original']);

/**
 * GET /api/poster/ext?u=<url> — a poster hosted by a plugin's source (e.g. a
 * source's Top 10), fetched and cached by dlvault so the browser never talks to
 * the source (hotlink / Cloudflare checks on images). Only hosts a loaded plugin
 * declared in cspDomains, only https, only image answers up to 2 MB.
 */
const extCache = new Map<string, { body: Buffer; type: string; ts: number }>();
const EXT_MAX_BYTES = 2 * 1024 * 1024;
router.get('/ext', async (req: Request, res: Response) => {
  let url: URL;
  try { url = new URL(String(req.query.u || '')); } catch { res.status(400).end(); return; }
  const allowed = pluginRegistry.getCspDomains().map(d => d.replace(/^https?:\/\//, '').toLowerCase());
  if (url.protocol !== 'https:' || !allowed.includes(url.hostname.toLowerCase()) || !url.pathname.startsWith('/media/')) {
    res.status(403).end();
    return;
  }
  const key = url.toString();
  let hit = extCache.get(key);
  if (!hit || Date.now() - hit.ts > CACHE_TTL) {
    try {
      const r = await axios.get(key, {
        responseType: 'arraybuffer', timeout: 10000, maxContentLength: EXT_MAX_BYTES, maxRedirects: 0,
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0' },
        validateStatus: s => s === 200,
      });
      const type = String(r.headers['content-type'] || '');
      if (!type.startsWith('image/')) { res.status(502).end(); return; }
      hit = { body: Buffer.from(r.data), type, ts: Date.now() };
      extCache.set(key, hit);
      if (extCache.size > 200) extCache.delete(extCache.keys().next().value as string);
    } catch {
      res.status(404).end();
      return;
    }
  }
  res.setHeader('Content-Type', hit.type);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(hit.body);
});

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
