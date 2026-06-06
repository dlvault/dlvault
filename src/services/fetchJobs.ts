/**
 * In-memory registry of self-download jobs (plugin fetchRelease runs), so the
 * UI's "active downloads" list survives a page reload — the download runs on
 * the server regardless of the browser, and this is where its live state lives.
 *
 * In-memory by design: a page refresh keeps the list (server-side state); a
 * container restart clears it (the download itself is gone then too). Completed
 * downloads also land in the activity log for the permanent record.
 */

export type FetchJobStatus = 'processing' | 'retrying' | 'done' | 'error';

/**
 * A failed background fetch retries itself after these pauses before it counts
 * as failed for good. Sources fail transiently (dropped transfers, a busy
 * transcoder, a Cloudflare hiccup); the plugin already retries within a run,
 * this covers outages that outlast one run. In-memory like the jobs: a
 * container restart forgets pending retries.
 */
export const FETCH_RETRY_DELAYS_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

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
  /** Runs so far (1 = first try) and the most there will be. */
  attempt: number;
  maxAttempts: number;
  /** While 'retrying': when the next run starts (epoch ms). */
  nextRetryAt?: number;
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
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let seq = 0;

export function createFetchJob(pluginId: string, title: string): FetchJob {
  const job: FetchJob = {
    id: `fj_${++seq}`,
    pluginId,
    title,
    status: 'processing',
    startedAt: Date.now(),
    attempt: 1,
    maxAttempts: FETCH_RETRY_DELAYS_MS.length + 1,
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
  job.nextRetryAt = undefined;
  // Reflect the real number of files written (an album with some failed tracks
  // wrote fewer than tracksTotal — don't claim "10/10" when 7 landed).
  if (result.ok && job.tracksTotal) job.tracksDone = result.files?.length ?? job.tracksTotal;
}

export function getFetchJob(id: string): FetchJob | undefined {
  return jobs.find(j => j.id === id);
}

/**
 * Park a failed job and run `rerun` after the next backoff pause. Returns false
 * when the job has used up its attempts — the caller then finishes it as failed.
 */
export function scheduleFetchRetry(id: string, error: string | undefined, rerun: () => void): boolean {
  const job = jobs.find(j => j.id === id);
  if (!job || job.status !== 'processing') return false;
  const delay = FETCH_RETRY_DELAYS_MS[job.attempt - 1];
  if (delay === undefined) return false;
  job.status = 'retrying';
  job.error = error;
  job.nextRetryAt = Date.now() + delay;
  job.speedBps = undefined;
  job.currentTrack = undefined;
  const timer = setTimeout(() => {
    retryTimers.delete(id);
    if (restartFetchJob(id)) rerun();
  }, delay);
  timer.unref?.();
  retryTimers.set(id, timer);
  return true;
}

/** Start a parked job's next run now (timer fired, or the user asked again). */
export function restartFetchJob(id: string): boolean {
  const job = jobs.find(j => j.id === id);
  if (!job || job.status !== 'retrying') return false;
  clearTimeout(retryTimers.get(id));
  retryTimers.delete(id);
  job.status = 'processing';
  job.attempt += 1;
  job.nextRetryAt = undefined;
  job.detail = `Versuch ${job.attempt}/${job.maxAttempts}`;
  return true;
}

/** Drop a parked job's pending retry (user cancelled it). */
export function cancelFetchRetry(id: string): void {
  clearTimeout(retryTimers.get(id));
  retryTimers.delete(id);
  const job = jobs.find(j => j.id === id);
  if (job) job.nextRetryAt = undefined;
}

/** Test helper — clear the in-memory job list between cases. */
export function _resetFetchJobs(): void {
  for (const t of retryTimers.values()) clearTimeout(t);
  retryTimers.clear();
  jobs.length = 0;
  seq = 0;
}

/** Recent jobs, newest first. Optionally scoped to one plugin. */
export function listFetchJobs(pluginId?: string, limit = 50): FetchJob[] {
  const list = pluginId ? jobs.filter(j => j.pluginId === pluginId) : jobs;
  return list.slice(0, limit);
}
