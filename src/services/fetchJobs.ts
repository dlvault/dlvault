/**
 * In-memory registry of self-download jobs (plugin fetchRelease runs), so the
 * UI's "active downloads" list survives a page reload — the download runs on
 * the server regardless of the browser, and this is where its live state lives.
 *
 * In-memory by design: a page refresh keeps the list (server-side state); a
 * container restart clears it (the download itself is gone then too). Completed
 * downloads also land in the activity log for the permanent record.
 */

export type FetchJobStatus = 'processing' | 'done' | 'error';

export interface FetchJob {
  id: string;
  pluginId: string;
  title: string;
  status: FetchJobStatus;
  /** Latest progress line while processing (e.g. "Track 2/5" / "downscale"). */
  detail?: string;
  /** 0..1 completion ratio while processing, when the source can estimate it. */
  progress?: number;
  /** Live download rate in bytes/sec, when the plugin can measure it. */
  speedBps?: number;
  /** Album fetches: total tracks / tracks fully written / current track title. */
  tracksTotal?: number;
  tracksDone?: number;
  currentTrack?: string;
  /** Artist + cover-art URL, when the source exposes them (richer UI). */
  artist?: string;
  cover?: string;
  startedAt: number;
  finishedAt?: number;
  files?: string[];
  error?: string;
}

/** A live progress patch — mirrors the plugin FetchProgress shape. */
export interface FetchJobPatch {
  message?: string;
  ratio?: number;
  speedBps?: number;
  tracksTotal?: number;
  tracksDone?: number;
  currentTrack?: string;
  artist?: string;
  cover?: string;
}

const MAX_JOBS = 100;
const jobs: FetchJob[] = [];
let seq = 0;

export function createFetchJob(pluginId: string, title: string): FetchJob {
  const job: FetchJob = {
    id: `fj_${++seq}`,
    pluginId,
    title,
    status: 'processing',
    startedAt: Date.now(),
  };
  jobs.unshift(job);
  if (jobs.length > MAX_JOBS) jobs.length = MAX_JOBS;
  return job;
}

/** Merge a live progress patch into a still-processing job. */
export function updateFetchJob(id: string, patch: FetchJobPatch): void {
  const job = jobs.find(j => j.id === id);
  if (!job || job.status !== 'processing') return;
  if (patch.message !== undefined) job.detail = patch.message;
  if (patch.ratio !== undefined) job.progress = patch.ratio;
  if (patch.speedBps !== undefined) job.speedBps = patch.speedBps;
  if (patch.tracksTotal !== undefined) job.tracksTotal = patch.tracksTotal;
  if (patch.tracksDone !== undefined) job.tracksDone = patch.tracksDone;
  if (patch.currentTrack !== undefined) job.currentTrack = patch.currentTrack;
  if (patch.artist !== undefined) job.artist = patch.artist;
  if (patch.cover !== undefined) job.cover = patch.cover;
}

export function finishFetchJob(
  id: string,
  result: { ok: boolean; files?: string[]; error?: string },
): void {
  const job = jobs.find(j => j.id === id);
  if (!job) return;
  job.status = result.ok ? 'done' : 'error';
  job.finishedAt = Date.now();
  job.files = result.files;
  job.error = result.error;
  // A finished job has no live throughput — clear it so the UI stops showing a
  // stale speed / "now playing" track for a completed download.
  job.speedBps = undefined;
  job.currentTrack = undefined;
  // Reflect the real number of files written (an album with some failed tracks
  // wrote fewer than tracksTotal — don't claim "10/10" when 7 landed).
  if (result.ok && job.tracksTotal) job.tracksDone = result.files?.length ?? job.tracksTotal;
}

/** Test helper — clear the in-memory job list between cases. */
export function _resetFetchJobs(): void {
  jobs.length = 0;
  seq = 0;
}

/** Recent jobs, newest first. Optionally scoped to one plugin. */
export function listFetchJobs(pluginId?: string, limit = 50): FetchJob[] {
  const list = pluginId ? jobs.filter(j => j.pluginId === pluginId) : jobs;
  return list.slice(0, limit);
}
