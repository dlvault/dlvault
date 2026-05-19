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
