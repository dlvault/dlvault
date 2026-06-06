/** JDownloader package names as dlvault builds them — pure string helpers. */

/**
 * A JD package name as dlvault sent it. JD rewrites ':' to ';' in the names
 * it echoes back — "Henry Danger; Der Film" matched no title and showed the
 * semicolon. (The backend's own matching already accounts for this.)
 */
export function jdName(name: string | null | undefined): string {
  return (name || '').replace(/;/g, ':');
}

/**
 * "Title (Year)" prefix of a dlvault package name — or just "Title" for a
 * title without a year, which dlvault sends as "Title - 1080p". Null for
 * names dlvault did not build.
 */
export function packageKey(name: string | null | undefined): string | null {
  const n = jdName(name);
  const m = n.match(/^(.+? \(\d{4}\))/);
  if (m) return m[1];
  const noYear = n.match(/^(.+?) - (?:S\d{2}|\d{3,4}p|4K|\[)/i);
  return noYear ? noYear[1] : null;
}

export function parsed(rawName: string): { title: string; year?: number } {
  const name = jdName(rawName);
  // dlvault packages are named "Title (Year)"
  const m = name.match(/^(.+?) \((\d{4})\)/);
  if (m) return { title: m[1], year: Number(m[2]) };
  // scene-style "The.Title.2049.2160p..." → title up to the year
  const sm = name.match(/^(.*?)[. _](19|20)(\d{2})[. _]/);
  if (sm) return { title: sm[1].replace(/[._]/g, ' ').trim(), year: Number(sm[2] + sm[3]) };
  return { title: name.replace(/\.(mkv|mp4|rar|zip|avi)$/i, '').replace(/[._]/g, ' '), year: undefined };
}
