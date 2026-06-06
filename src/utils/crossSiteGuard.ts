import type { Request, Response, NextFunction } from 'express';

/**
 * Refuse state-changing API calls that a FOREIGN web page sends through the
 * user's browser (CSRF).
 *
 * dlvault normally runs on the LAN without a token. CORS stops a foreign page
 * from READING answers and from sending JSON bodies, but not from firing a
 * body-less POST: any page the owner opened could stop all downloads, start a
 * sync, re-download titles or restore an old backup on the LAN address.
 *
 * Browsers mark every request with where it came from — `Sec-Fetch-Site` and
 * `Origin` — and a page cannot forge either. A request from dlvault's own UI is
 * same-origin; scripts, Seerr and curl send neither header and are not CSRF
 * vectors, so they pass untouched.
 */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function crossSiteGuard(req: Request, res: Response, next: NextFunction): void {
  if (!UNSAFE.has(req.method)) { next(); return; }

  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') { refuse(res); return; }

  const origin = req.headers.origin;
  if (origin !== undefined) {
    let o: URL | null = null;
    try { o = new URL(String(origin)); } catch { /* "null" or garbage */ }
    // The Host the browser addressed — behind a reverse proxy the proxy passes
    // it on (nginx `proxy_set_header Host $host`), so it still equals the origin.
    const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
    const host = String(req.headers.host || '').toLowerCase();
    if (!o || o.protocol === 'null:' || ![host, forwarded].some(h => h && sameHost(o!, h))) { refuse(res); return; }
  }
  next();
}

/**
 * Origin and Host name the same server. nginx's `$host` carries no port, so a
 * page opened as https://name:18443 reaches dlvault with "Host: name" — then
 * only the name is compared. With a port in Host it must match exactly: another
 * service on the same machine (other port) is another origin.
 */
function sameHost(origin: URL, host: string): boolean {
  if (origin.host.toLowerCase() === host) return true;
  return !/:\d+$/.test(host) && !host.startsWith('[') && origin.hostname.toLowerCase() === host;
}

function refuse(res: Response): void {
  res.status(403).json({ error: 'Anfrage von einer fremden Seite abgelehnt' });
}
