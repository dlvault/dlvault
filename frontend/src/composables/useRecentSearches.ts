const KEY = 'dlvault.recent-searches';
const MAX = 5;

export function readRecentSearches(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, MAX) : [];
  } catch { return []; }
}

export function rememberSearch(term: string) {
  const q = term.trim();
  if (!q) return;
  const list = [q, ...readRecentSearches().filter(r => r.toLowerCase() !== q.toLowerCase())].slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* best-effort */ }
}
