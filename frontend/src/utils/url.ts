/**
 * Only http(s) links may be rendered as clickable — a plugin manifest is
 * untrusted until accepted, and "javascript:" in an href is still a link.
 */
export function isWebUrl(u: string | null | undefined): u is string {
  if (!u) return false;
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}
