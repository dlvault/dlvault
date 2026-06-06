/**
 * Format a Date as SQLite's datetime('now') representation:
 * space-separated UTC, "YYYY-MM-DD HH:MM:SS" (no "T", no milliseconds, no "Z").
 *
 * This matters for string comparisons against `created_at` columns. A raw
 * toISOString() value is "T"-separated and the "T" (0x54) sorts lexicographically
 * *after* the space (0x20) SQLite stores, so an ISO cutoff silently drops rows
 * whose stored timestamp shares the cutoff's calendar day.
 */
export function toSqliteUtc(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Parse a SQLite datetime() value to ms-since-epoch, forcing UTC interpretation.
 *
 * SQLite's `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" — UTC but without a
 * "Z" suffix. V8 parses bare space-separated strings as LOCAL time, so
 * `new Date(stored).getTime()` is shifted by the host's TZ offset. In a
 * `TZ=Europe/Berlin` container that's a 2h offset, falsely tripping the 1h/2h
 * stale thresholds seconds after a fresh write.
 *
 * Accepts both SQLite ("Y-M-D H:M:S") and ISO ("...T...Z") formats so test
 * fixtures that build timestamps via `toISOString()` keep working.
 */
export function parseUtcDate(s: string): number {
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}
