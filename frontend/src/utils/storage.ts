/**
 * localStorage that never throws. Blocked site data, private windows and some
 * embedded browsers throw on ANY access — at module load that kept the whole
 * app from starting. Everything stored here is a convenience; losing it is fine.
 */
export const safeStorage = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* not available */ }
  },
  remove(key: string): void {
    try { localStorage.removeItem(key); } catch { /* not available */ }
  },
};
