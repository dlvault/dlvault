import { num } from '../../composables/useFormatters';
import { matchByTitle } from '../../utils/titleMatch';
import type { DownloadPackage, Movie } from '../../types/index';
import { useDownloadsStore } from '../../stores/downloads';

/**
 * Shared package presentation for the Downloads view and its sections: the
 * stage a package is in, its progress, and the title/year/quality guessed out of
 * a JDownloader package name.
 *
 * These live next to the components rather than in the store because they are
 * presentation, not state — same reason `library/libraryItem.ts` exists. What
 * JD's status strings actually MEAN stays in the downloads store; `stageOf` only
 * turns that into a label and a colour.
 */

export type Stage = { key: string; label: string; color: string };

export function stageOf(p: DownloadPackage): Stage {
  const dlStore = useDownloadsStore();
  if (dlStore.isError(p)) return { key: 'error', label: 'Fehler', color: 'var(--err)' };
  if (dlStore.isExtracting(p)) return { key: 'extracting', label: 'Entpacken', color: 'var(--stage-extracting)' };
  if (dlStore.isMoved(p)) return { key: 'moved', label: 'Verschoben', color: 'var(--stage-moved)' };
  if (p.finished) return { key: 'finished', label: 'Fertig', color: 'var(--stage-library)' };
  if (p.running) return { key: 'downloading', label: 'Lädt', color: 'var(--stage-downloading)' };
  return { key: 'pending', label: 'Wartet', color: 'var(--stage-pending)' };
}

export function pct(p: DownloadPackage): number {
  const key = stageOf(p).key;
  if (key === 'extracting') {
    const ep = p.extractionProgress;
    return typeof ep === 'number' && ep > 0 ? Math.round(ep) : 0;
  }
  if (key === 'moved' || key === 'finished') return 100;
  if (!p.bytesTotal) return 0;
  return Math.round((p.bytesLoaded / p.bytesTotal) * 100);
}

/** JD package names → title / year. */
// Name parsing lives in utils/packageName (no Vue/Pinia — unit-testable on its own).
export { jdName, packageKey, parsed } from '../../utils/packageName';
import { parsed } from '../../utils/packageName';

export function quality(name: string): string {
  if (/2160p|\buhd\b|\b4k\b/i.test(name)) return '4K';
  if (/1080p/i.test(name)) return '1080p';
  if (/720p/i.test(name)) return '720p';
  return '';
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function matchMovie(pkg: DownloadPackage, movies: Movie[]): Movie | null {
  const p = parsed(pkg.name);
  return matchByTitle(movies, m => ({ title: m.title, year: m.year }), { title: p.title, year: p.year });
}

export function fmtDiskGB(gb: number): string {
  if (gb >= 1024) return num(gb / 1024, 2) + ' TB';
  return Math.round(gb) + ' GB';
}

/**
 * Music downloads still in flight. The header pill counts them and the hero sums
 * their throughput — one definition, so the two can't drift apart on what counts
 * as "active".
 */
export function activeMusicDownloads<T extends { status?: string }>(list: T[]): T[] {
  return list.filter((d) => {
    const s = (d.status || '').toLowerCase();
    // 'retrying' is parked until its next automatic try — nothing is loading.
    return s !== 'completed' && s !== 'error' && s !== 'failed' && s !== 'retrying';
  });
}
