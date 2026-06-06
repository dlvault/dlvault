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
export function parsed(name: string): { title: string; year?: number } {
  // dlvault packages are named "Title (Year)"
  const m = name.match(/^(.+?) \((\d{4})\)/);
  if (m) return { title: m[1], year: Number(m[2]) };
  // scene-style "The.Title.2049.2160p..." → title up to the year
  const sm = name.match(/^(.*?)[. _](19|20)(\d{2})[. _]/);
  if (sm) return { title: sm[1].replace(/[._]/g, ' ').trim(), year: Number(sm[2] + sm[3]) };
  return { title: name.replace(/\.(mkv|mp4|rar|zip|avi)$/i, '').replace(/[._]/g, ' '), year: undefined };
}

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
  return movies.find(m => m.title === p.title && m.year === p.year)
    || movies.find(m => m.title === p.title)
    || null;
}

export function fmtDiskGB(gb: number): string {
  if (gb >= 1024) return (gb / 1024).toFixed(2) + ' TB';
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
    return s !== 'completed' && s !== 'error' && s !== 'failed';
  });
}
