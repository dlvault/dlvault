/**
 * Match a title from one list (library item, JD package, queue row) to an
 * entry of another when no shared id exists.
 *
 * Title + year (+ media type when both sides know it) is required. A bare
 * title match is only accepted when one side has no year AND exactly one
 * candidate carries that title — "Dune (1984)" must never open (and let the
 * panel's actions write to) the queue row of "Dune (2021)".
 */
export function norm(t: string | null | undefined): string {
  return (t || '').normalize('NFC').trim().toLowerCase();
}

export function matchByTitle<T>(
  candidates: readonly T[],
  get: (c: T) => { title: string; year?: number | null; mediaType?: string | null },
  want: { title: string; year?: number | null; mediaType?: string | null },
): T | null {
  const t = norm(want.title);
  if (!t) return null;
  const sameType = (c: T) => {
    const mt = get(c).mediaType;
    return !want.mediaType || !mt || mt === want.mediaType;
  };
  const byTitle = candidates.filter(c => norm(get(c).title) === t && sameType(c));
  if (want.year) {
    const exact = byTitle.find(c => get(c).year === want.year);
    if (exact) return exact;
    const yearless = byTitle.filter(c => !get(c).year);
    return yearless.length === 1 ? yearless[0] : null;
  }
  return byTitle.length === 1 ? byTitle[0] : null;
}
