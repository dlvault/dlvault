import fs from 'fs';
import { getSetting } from '../database/index';

/**
 * Is there room for a download before it is sent to JDownloader?
 *
 * Without this a full disk was only noticed at the very end: JD stalled or the
 * library move failed, after the captcha was spent and the bytes fetched. The
 * check runs before link resolution, so a full disk costs nothing but a wait.
 *
 * Both the download folder and the library target need the release size plus a
 * reserve. When they sit on the same filesystem (one Unraid share behind two
 * mounts), the cross-mount copy holds the file twice for a moment.
 */

export type RoomVerdict = { ok: true } | { ok: false; detail: string };

interface FsInfo { free: number; id: string }

function fsInfo(p: string): FsInfo | null {
  try {
    const s = fs.statfsSync(p);
    // statfs has no device id; total size + block size identify a filesystem
    // well enough to tell "two mounts of one share" from "two disks".
    return { free: s.bavail * s.bsize, id: `${s.type}:${s.blocks}:${s.bsize}` };
  } catch {
    return null;
  }
}

const GB = 1024 ** 3;

export function reserveBytes(): number {
  const n = parseFloat(getSetting('disk.reserve_gb') || '');
  return (Number.isFinite(n) && n >= 0 ? n : 20) * GB;
}

/** Pure rule, for tests: free bytes per path (null = unknown) against the need. */
export function judgeRoom(
  paths: { label: string; info: FsInfo | null }[],
  sizeBytes: number,
  reserve: number,
): RoomVerdict {
  const seen = new Map<string, number>();   // fs id → bytes needed on it
  for (const p of paths) {
    if (!p.info) continue;
    seen.set(p.info.id, (seen.get(p.info.id) ?? 0) + sizeBytes);
  }
  for (const p of paths) {
    if (!p.info) continue;
    const need = (seen.get(p.info.id) ?? sizeBytes) + reserve;
    if (p.info.free < need) {
      return {
        ok: false,
        detail: `${p.label}: ${(p.info.free / GB).toFixed(1)} GB frei, ${(need / GB).toFixed(1)} GB nötig`,
      };
    }
  }
  return { ok: true };
}

/**
 * @param sizeMB    the release's stated size (0 = unknown → only the reserve counts)
 * @param targets   label → path; unreadable paths are not judged
 */
export function checkRoom(sizeMB: number, targets: Record<string, string | null | undefined>): RoomVerdict {
  if (getSetting('disk.guard') === 'false') return { ok: true };
  const paths = Object.entries(targets)
    .filter(([, p]) => !!p)
    .map(([label, p]) => ({ label, info: fsInfo(p as string) }));
  return judgeRoom(paths, Math.max(0, sizeMB) * 1024 * 1024, reserveBytes());
}
