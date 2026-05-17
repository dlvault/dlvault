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

// Host-side path to the data volume — needed so the updater can bind-mount
// the same data directory and stream progress into the shared status log.
const HOST_DATA_DIR  = process.env.HOST_DATA_DIR  || '';

// Status log lives in the shared data volume so it survives the main-container restart.
const STATUS_LOG     = path.join(process.env.DATA_DIR || '/app/data', 'update-status.log');

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
 * Ensure the updater image is available locally. If it isn't, try to pull it
 * from its registry. This eliminates the "Updater image missing — run setup
 * script" footgun: as long as the host has network access to the registry,
 * the first one-click update Just Works.
 */
export async function ensureUpdaterImage(): Promise<{ available: boolean; pulled: boolean; error?: string }> {
  if (await imageExists(UPDATER_IMAGE)) {
    return { available: true, pulled: false };
  }
  logger.info(`Updater image ${UPDATER_IMAGE} not present — pulling…`);
  const ok = await pullImage(UPDATER_IMAGE);
  if (!ok) {
    return { available: false, pulled: false, error: 'pull_failed' };
  }
  const present = await imageExists(UPDATER_IMAGE);
  if (!present) {
    return { available: false, pulled: false, error: 'pull_completed_but_image_absent' };
  }
  logger.info(`Updater image ${UPDATER_IMAGE} pulled`);
  return { available: true, pulled: true };
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

  // HOST_DATA_DIR must be set so the updater can bind-mount the status log
  // location. (HOST_REPO_DIR is no longer required — updates are pulled from
  // the registry, no local git clone needed.)
  if (!HOST_DATA_DIR) {
    return res.status(412).json({
      error: 'host_data_dir_missing',
      hint: 'Set HOST_DATA_DIR env var on the main container to your host-side data path.',
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

  // Create + start updater container.
  const env: string[] = [
    `MAIN_CONTAINER=${MAIN_CONTAINER}`,
    `IMAGE_NAME=${MAIN_IMAGE}`,
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
        `${HOST_DATA_DIR}:/status`,
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
      return res.status(502).json({ error: 'create_failed', detail: created.body });
    }
    const start = await dockerRequest('POST', `/containers/${UPDATER_NAME}/start`);
    if (start.status !== 204) {
      logger.error('Updater start failed:', start.status, start.body);
      return res.status(502).json({ error: 'start_failed', detail: start.body });
    }
    logger.info(`Update started — updater container ${UPDATER_NAME} is running`);
    res.status(202).json({ ok: true, stream: '/api/update/stream' });
  } catch (err) {
    logger.error('Update start error:', (err as Error).message);
    res.status(500).json({ error: 'internal', message: (err as Error).message });
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

// ── GET /api/update/state — quick poll endpoint (is an update running?) ─
router.get('/state', async (_req: Request, res: Response) => {
  const state = await containerState(UPDATER_NAME);
  // Image is "available" if it's already cached locally OR can plausibly be
  // pulled (we don't actually pull here — that happens lazily at /start).
  const updaterAvailable = await imageExists(UPDATER_IMAGE);
  res.json({
    running: state === 'running',
    updaterAvailable,
    canStart: state !== 'running' && !!HOST_DATA_DIR,
    hostPathsConfigured: !!HOST_DATA_DIR,
  });
});

export default router;
