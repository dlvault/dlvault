import { Router, Request, Response } from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger';

const router = Router();

// ── Config ─────────────────────────────────────────────────────────────
const DOCKER_SOCK    = process.env.DOCKER_SOCK   || '/var/run/docker.sock';
const UPDATER_IMAGE  = process.env.UPDATER_IMAGE || 'ghcr.io/dlvault/dlvault-updater:latest';
const UPDATER_NAME   = 'dlvault-updater';
const MAIN_CONTAINER = process.env.MAIN_CONTAINER || 'dlvault';
const MAIN_IMAGE     = process.env.MAIN_IMAGE     || 'ghcr.io/dlvault/dlvault:latest';

// Status log lives in the shared data volume so it survives the main-container restart.
const DATA_DIR_IN_CONTAINER = process.env.DATA_DIR || '/app/data';
const STATUS_LOG     = path.join(DATA_DIR_IN_CONTAINER, 'update-status.log');

// Host-side path to the data volume — needed so the updater can bind-mount
// the same data directory and stream progress into the shared status log.
// We try to auto-detect from a docker self-inspect first; HOST_DATA_DIR env
// is kept as an explicit override (and as a fallback if self-inspect fails).
let hostDataDirCache: string | null = null;
async function resolveHostDataDir(): Promise<string> {
  if (process.env.HOST_DATA_DIR) return process.env.HOST_DATA_DIR;
  if (hostDataDirCache !== null) return hostDataDirCache;
  try {
    // Inside Docker, /etc/hostname is set to the container id (12-char short).
    const selfId = fs.readFileSync('/etc/hostname', 'utf8').trim();
    if (!selfId) return '';
    const { status, body } = await dockerRequest<{ Mounts?: Array<{ Source: string; Destination: string }> }>(
      'GET',
      `/containers/${encodeURIComponent(selfId)}/json`,
    );
    if (status !== 200 || typeof body !== 'object' || !body?.Mounts) return '';
    const mount = body.Mounts.find(m => m.Destination === DATA_DIR_IN_CONTAINER);
    hostDataDirCache = mount?.Source || '';
    return hostDataDirCache;
  } catch (err: any) {
    logger.warn(`HOST_DATA_DIR auto-detect failed: ${err?.message || err}`);
    return '';
  }
}

// ── Docker Engine API helper ──────────────────────────────────────────
function dockerRequest<T = unknown>(
  method: 'GET' | 'POST' | 'DELETE',
  apiPath: string,
  body?: unknown,
): Promise<{ status: number; body: T | string }> {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        socketPath: DOCKER_SOCK,
        method,
        path: apiPath,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
        timeout: 10000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = raw;
          if (raw && res.headers['content-type']?.includes('application/json')) {
            try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed as T | string });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('docker socket timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────
async function imageExists(name: string): Promise<boolean> {
  try {
    const { status } = await dockerRequest('GET', `/images/${encodeURIComponent(name)}/json`);
    return status === 200;
  } catch { return false; }
}

interface ContainerInspect { State?: { Running?: boolean } }
async function containerState(name: string): Promise<'running' | 'stopped' | 'absent'> {
  try {
    const { status, body } = await dockerRequest<ContainerInspect>('GET', `/containers/${encodeURIComponent(name)}/json`);
    if (status === 404) return 'absent';
    if (status === 200 && typeof body === 'object' && body?.State?.Running) return 'running';
    return 'stopped';
  } catch { return 'absent'; }
}

async function removeContainer(name: string): Promise<void> {
  try {
    await dockerRequest('DELETE', `/containers/${encodeURIComponent(name)}?force=true&v=true`);
  } catch { /* ignore */ }
}

/**
 * Repo digest (`ghcr.io/...@sha256:...`) of the image THIS container runs, via a
 * docker self-inspect. Empty string when it can't be determined.
 */
async function runningImageDigest(): Promise<string> {
  try {
    const selfId = fs.readFileSync('/etc/hostname', 'utf8').trim();
    if (!selfId) return '';
    const c = await dockerRequest<{ Image?: string }>('GET', `/containers/${encodeURIComponent(selfId)}/json`);
    if (c.status !== 200 || typeof c.body !== 'object' || !c.body?.Image) return '';
    const img = await dockerRequest<{ RepoDigests?: string[] }>('GET', `/images/${encodeURIComponent(c.body.Image)}/json`);
    if (img.status !== 200 || typeof img.body !== 'object') return '';
    const repo = MAIN_IMAGE.split(':')[0];
    const digests = img.body?.RepoDigests || [];
    const match = digests.find(d => d.startsWith(`${repo}@`)) || digests[0];
    return match ? (match.split('@')[1] || '') : '';
  } catch { return ''; }
}

/**
 * Registry digest MAIN_IMAGE's tag points at right now, via the docker engine's
 * `/distribution` endpoint — a manifest lookup that does NOT pull the image.
 * Empty string on failure. Works on Docker Desktop too (uses the engine's own
 * registry access, no manual token dance).
 */
async function registryImageDigest(): Promise<string> {
  try {
    const { status, body } = await dockerRequest<{ Descriptor?: { digest?: string } }>(
      'GET', `/distribution/${encodeURIComponent(MAIN_IMAGE)}/json`,
    );
    if (status !== 200 || typeof body !== 'object') return '';
    return body?.Descriptor?.digest || '';
  } catch { return ''; }
}

/**
 * Whether the registry tag points at a DIFFERENT image than the one we run —
 * i.e. a rebuilt image is actually available to pull. `null` when it can't be
 * determined (no docker.sock / registry unreachable) so the caller can fall back.
 *
 * This is the gate the update banner needs: GitHub's `main` HEAD changes the
 * instant code is pushed, ~10 min BEFORE CI finishes building + pushing the
 * image. Without it, the banner appears (and a click no-op-pulls the same
 * image) for the whole build window.
 */
export async function registryHasNewerImage(): Promise<boolean | null> {
  try {
    const [running, latest] = await Promise.all([runningImageDigest(), registryImageDigest()]);
    if (!running || !latest) return null;
    return running !== latest;
  } catch (err: any) {
    // Any failure (no docker.sock, registry unreachable, parse error) → "can't
    // tell". Never let this break the update-check; the caller falls back to the
    // commit comparison so non-docker hosts still get a banner.
    logger.debug(`registryHasNewerImage failed: ${err?.message || err}`);
    return null;
  }
}

/**
 * Pull an image from its registry via the Docker engine's streaming endpoint.
 * Resolves once the pull terminates (the response stream completes). Returns
 * `false` on HTTP error or socket failure.
 */
function pullImage(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const apiPath = `/images/create?fromImage=${encodeURIComponent(name)}`;
    const req = http.request(
      { socketPath: DOCKER_SOCK, method: 'POST', path: apiPath, timeout: 600_000 },
      (res) => {
        // Drain the streaming JSON; we only care about completion + status code.
        res.on('data', () => { /* ignore progress lines */ });
        res.on('end', () => resolve(res.statusCode === 200));
        res.on('error', () => resolve(false));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Ensure the updater image is up-to-date locally — *always* pull, not just
 * when missing. The cost is ~250 ms when the registry manifest matches the
 * cached one (Docker short-circuits), versus shipping a stale updater bundle
 * forever if we only fetched once on first-run. Stale updater = stale fixes,
 * including the GIT_COMMIT env-carry-forward repair that lives in update.sh
 * itself — without an actual pull the running updater image keeps the old
 * version of that script.
 */
export async function ensureUpdaterImage(): Promise<{ available: boolean; pulled: boolean; error?: string }> {
  const hadBefore = await imageExists(UPDATER_IMAGE);
  logger.info(`Updater image ${UPDATER_IMAGE} ${hadBefore ? 'present — refreshing' : 'not present — pulling'}…`);
  const ok = await pullImage(UPDATER_IMAGE);
  if (!ok) {
    if (hadBefore) {
      // Pull failed but a (possibly stale) image is already there — let the
      // update proceed with what we've got rather than hard-fail.
      logger.warn(`Updater pull failed; using cached ${UPDATER_IMAGE}`);
      return { available: true, pulled: false, error: 'pull_failed_using_cache' };
    }
    return { available: false, pulled: false, error: 'pull_failed' };
  }
  const present = await imageExists(UPDATER_IMAGE);
  if (!present) {
    return { available: false, pulled: false, error: 'pull_completed_but_image_absent' };
  }
  return { available: true, pulled: !hadBefore };
}

// ── POST /api/update/start ─────────────────────────────────────────────
router.post('/start', async (req: Request, res: Response) => {
  // CSRF-light: require explicit confirm header so accidental/cross-site
  // browser activity cannot trigger a host-level update.
  if (req.headers['x-confirm-update'] !== 'yes') {
    return res.status(403).json({ error: 'missing_confirm_header' });
  }

  // Pre-flight: docker socket reachable?
  try {
    const { status } = await dockerRequest('GET', '/_ping');
    if (status !== 200) return res.status(503).json({ error: 'docker_socket_unreachable' });
  } catch {
    return res.status(503).json({ error: 'docker_socket_unreachable' });
  }

  // HOST_DATA_DIR is needed so the updater can bind-mount the status log
  // location. We try to auto-detect it via docker self-inspect; the env var
  // remains an explicit override for unusual setups.
  const hostDataDir = await resolveHostDataDir();
  if (!hostDataDir) {
    return res.status(412).json({
      error: 'host_data_dir_missing',
      hint: 'Could not auto-detect the host path bound to /app/data. Set HOST_DATA_DIR env var on the main container as a manual override.',
    });
  }

  // If the updater image isn't local, pull it from its registry. The pull
  // can take a few seconds — that's an acceptable cost for the first update;
  // subsequent updates find it cached.
  const ensure = await ensureUpdaterImage();
  if (!ensure.available) {
    return res.status(502).json({
      error: 'updater_image_unavailable',
      hint: `Could not pull ${UPDATER_IMAGE} (${ensure.error}). Check network access to the registry.`,
    });
  }

  // Already running?
  const existing = await containerState(UPDATER_NAME);
  if (existing === 'running') {
    return res.status(409).json({ error: 'update_already_running' });
  }
  if (existing === 'stopped') {
    await removeContainer(UPDATER_NAME);
  }

  // Truncate status log so frontend tail starts clean.
  try { fs.writeFileSync(STATUS_LOG, ''); } catch { /* will be created by updater */ }

  // Create + start updater container. STATUS_FILE points at the same on-host
  // file the SSE stream tails — without this the updater defaults to
  // /status/update.log while the backend watches /status/update-status.log,
  // so phase events never reach the UI even though the update succeeds.
  const env: string[] = [
    `MAIN_CONTAINER=${MAIN_CONTAINER}`,
    `IMAGE_NAME=${MAIN_IMAGE}`,
    `STATUS_FILE=/status/${path.basename(STATUS_LOG)}`,
  ];
  if (process.env.REGISTRY_AUTH) env.push(`REGISTRY_AUTH=${process.env.REGISTRY_AUTH}`);

  const createBody = {
    Image: UPDATER_IMAGE,
    Env: env,
    HostConfig: {
      AutoRemove: true,
      RestartPolicy: { Name: 'no' },
      Binds: [
        `${DOCKER_SOCK}:/var/run/docker.sock`,
        `${hostDataDir}:/status`,
      ],
    },
  };

  try {
    const created = await dockerRequest<{ Id?: string; message?: string }>(
      'POST',
      `/containers/create?name=${UPDATER_NAME}`,
      createBody,
    );
    if (created.status !== 201) {
      logger.error('Updater create failed:', created.status, created.body);
      return res.status(502).json({ error: 'create_failed' });
    }
    const start = await dockerRequest('POST', `/containers/${UPDATER_NAME}/start`);
    if (start.status !== 204) {
      logger.error('Updater start failed:', start.status, start.body);
      return res.status(502).json({ error: 'start_failed' });
    }
    logger.info(`Update started — updater container ${UPDATER_NAME} is running`);
    res.status(202).json({ ok: true, stream: '/api/update/stream' });
  } catch (err) {
    logger.error('Update start error:', (err as Error).message);
    res.status(500).json({ error: 'internal' });
  }
});

// ── GET /api/update/stream — SSE tail of update-status.log ─────────────
router.get('/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  let position = 0;
  let watcher: fs.FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  const send = (event: string, data: unknown) => {
    if (closed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
  };

  // Pump any new bytes from STATUS_LOG[position..end] into the SSE stream.
  const pump = () => {
    if (closed) return;
    try {
      if (!fs.existsSync(STATUS_LOG)) return;
      const stat = fs.statSync(STATUS_LOG);
      if (stat.size < position) position = 0; // log was truncated → restart
      if (stat.size === position) return;

      const fd = fs.openSync(STATUS_LOG, 'r');
      const len = stat.size - position;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, position);
      fs.closeSync(fd);
      position = stat.size;

      const text = buf.toString('utf8');
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trimEnd();
        if (!line) continue;
        const phaseMatch = line.match(/PHASE:([a-z_:]+(?::[^\s]+)?)/);
        if (phaseMatch) {
          send('phase', { phase: phaseMatch[1], line });
        } else {
          send('log', { line });
        }
      }
    } catch (err) {
      logger.error('SSE pump error:', (err as Error).message);
    }
  };

  send('connected', { logPath: STATUS_LOG });
  pump(); // flush whatever already exists so reconnect picks up where it left off

  try {
    const dir = path.dirname(STATUS_LOG);
    watcher = fs.watch(dir, (_evt, fname) => {
      if (fname && fname.toString() === path.basename(STATUS_LOG)) pump();
    });
  } catch { /* directory may not exist yet */ }

  // Belt + braces poll in case fs.watch misses an event (happens on some FS).
  pollTimer = setInterval(pump, 1000);

  const keepalive = setInterval(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 30000);

  req.on('close', () => {
    closed = true;
    if (watcher) try { watcher.close(); } catch { /* ignore */ }
    if (pollTimer) clearInterval(pollTimer);
    clearInterval(keepalive);
  });
});

async function dockerSocketReachable(): Promise<boolean> {
  try {
    const { status } = await dockerRequest('GET', '/_ping');
    return status === 200;
  } catch {
    return false;
  }
}

// ── GET /api/update/state — quick poll endpoint (is an update running?) ─
router.get('/state', async (_req: Request, res: Response) => {
  const state = await containerState(UPDATER_NAME);
  // Image is "available" if it's already cached locally OR can plausibly be
  // pulled (we don't actually pull here — that happens lazily at /start).
  const updaterAvailable = await imageExists(UPDATER_IMAGE);
  const socketReachable = await dockerSocketReachable();
  const hostDataDir = await resolveHostDataDir();
  res.json({
    running: state === 'running',
    updaterAvailable,
    socketReachable,
    canStart: state !== 'running' && !!hostDataDir && socketReachable,
    hostPathsConfigured: !!hostDataDir,
  });
});

export default router;
