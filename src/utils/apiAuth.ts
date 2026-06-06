import crypto from 'crypto';
import type { Request } from 'express';

/**
 * Token auth (only when API_TOKEN is set). A caller authenticates either with
 * `Authorization: Bearer <token>` (scripts) or with the HttpOnly cookie the UI
 * obtains once via POST /api/auth/login — EventSource cannot send headers, and
 * axios never sends the Bearer header, so the cookie is the browser's way.
 */
export const AUTH_COOKIE = 'dlvault_token';

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
  }
  return null;
}

export function tokenMatches(candidate: string | null | undefined, expected: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  // timingSafeEqual throws on length mismatch, so compare lengths first — that
  // leak is unavoidable and harmless next to the token's own entropy.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Bearer header or login cookie carries the configured token. */
export function requestHasToken(req: Request, expected: string): boolean {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  return tokenMatches(bearer, expected) || tokenMatches(readCookie(req, AUTH_COOKIE), expected);
}
