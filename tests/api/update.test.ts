import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── http mock ────────────────────────────────────────────────────────────
// Each entry scripts one http.request call: status code + (optional) JSON body.
// dockerRequest and pullImage both use http.request; we drive their callbacks.
type ScriptedResponse = { statusCode: number; json?: unknown; raw?: string };
const httpScript = vi.hoisted(() => ({ queue: [] as ScriptedResponse[], calls: [] as string[] }));

const mockHttpRequest = vi.hoisted(() => vi.fn());

vi.mock('node:http', () => ({
  default: { request: mockHttpRequest },
  request: mockHttpRequest,
}));

// ── fs mock ──────────────────────────────────────────────────────────────
const mockFs = vi.hoisted(() => ({
  readFileSync: vi.fn(() => 'abc123container'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ size: 0 })),
  openSync: vi.fn(() => 1),
  readSync: vi.fn(() => 0),
  closeSync: vi.fn(),
  watch: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock('node:fs', () => ({ default: mockFs, ...mockFs }));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function setupHttp() {
  mockHttpRequest.mockImplementation((_opts: any, cb?: (res: any) => void) => {
    const req = new EventEmitter() as any;
    req.write = vi.fn();
    req.end = vi.fn(() => {
      // Resolve asynchronously to mimic a real socket round-trip.
      setImmediate(() => {
        const scripted = httpScript.queue.shift() ?? { statusCode: 200 };
        const res = new EventEmitter() as any;
        res.statusCode = scripted.statusCode;
        res.headers = scripted.json !== undefined ? { 'content-type': 'application/json' } : {};
        if (cb) cb(res);
        const payload = scripted.json !== undefined ? JSON.stringify(scripted.json) : (scripted.raw ?? '');
        if (payload) res.emit('data', Buffer.from(payload));
        res.emit('end');
      });
    });
    req.destroy = vi.fn();
    return req;
  });
}

import express from 'express';
import request from 'supertest';
import router from '../../src/api/routes/update';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/update', router);
  return app;
}

const app = makeApp();

beforeEach(() => {
  vi.clearAllMocks();
  httpScript.queue = [];
  setupHttp();
  delete process.env.HOST_DATA_DIR;
  mockFs.readFileSync.mockReturnValue('abc123container');
  mockFs.existsSync.mockReturnValue(false);
});

describe('POST /api/update/start', () => {
  it('rejects without confirm header', async () => {
    const res = await request(app).post('/api/update/start');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'missing_confirm_header' });
  });

  it('returns 503 when docker socket unreachable', async () => {
    httpScript.queue = [{ statusCode: 500 }]; // /_ping
    const res = await request(app).post('/api/update/start').set('x-confirm-update', 'yes');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('docker_socket_unreachable');
  });

  it('returns 412 when host data dir cannot be resolved', async () => {
    // /_ping ok, then self-inspect returns no matching mount
    httpScript.queue = [
      { statusCode: 200 },                                        // /_ping
      { statusCode: 200, json: { Mounts: [] } },                  // self-inspect
    ];
    const res = await request(app).post('/api/update/start').set('x-confirm-update', 'yes');
    expect(res.status).toBe(412);
    expect(res.body.error).toBe('host_data_dir_missing');
  });

  it('returns 502 when updater image cannot be pulled', async () => {
    process.env.HOST_DATA_DIR = '/host/data';
    httpScript.queue = [
      { statusCode: 200 },              // /_ping
      { statusCode: 404 },              // imageExists (hadBefore=false)
      { statusCode: 500 },              // pullImage fails
    ];
    const res = await request(app).post('/api/update/start').set('x-confirm-update', 'yes');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('updater_image_unavailable');
  });

  it('returns 409 when an update is already running', async () => {
    process.env.HOST_DATA_DIR = '/host/data';
    httpScript.queue = [
      { statusCode: 200 },                                  // /_ping
      { statusCode: 200 },                                  // imageExists hadBefore=true
      { statusCode: 200 },                                  // pullImage ok
      { statusCode: 200 },                                  // imageExists present
      { statusCode: 200, json: { State: { Running: true } } }, // containerState running
    ];
    const res = await request(app).post('/api/update/start').set('x-confirm-update', 'yes');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('update_already_running');
  });

  it('starts the updater container successfully (202)', async () => {
    process.env.HOST_DATA_DIR = '/host/data';
    httpScript.queue = [
      { statusCode: 200 },                                  // /_ping
      { statusCode: 200 },                                  // imageExists hadBefore=true
      { statusCode: 200 },                                  // pullImage ok
      { statusCode: 200 },                                  // imageExists present
      { statusCode: 404 },                                  // containerState absent
      { statusCode: 201, json: { Id: 'newcontainer' } },    // create
      { statusCode: 204 },                                  // start
    ];
    const res = await request(app).post('/api/update/start').set('x-confirm-update', 'yes');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, stream: '/api/update/stream' });
    expect(mockFs.writeFileSync).toHaveBeenCalled();
  });

  it('returns 502 when container create fails', async () => {
    process.env.HOST_DATA_DIR = '/host/data';
    httpScript.queue = [
      { statusCode: 200 },                                  // /_ping
      { statusCode: 200 },                                  // imageExists hadBefore
      { statusCode: 200 },                                  // pullImage ok
      { statusCode: 200 },                                  // imageExists present
      { statusCode: 404 },                                  // containerState absent
      { statusCode: 500, json: { message: 'nope' } },       // create fails
    ];
    const res = await request(app).post('/api/update/start').set('x-confirm-update', 'yes');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('create_failed');
    // Docker engine error body ({ message: 'nope' }) must not leak to the client.
    expect(res.body).not.toHaveProperty('detail');
  });

  it('returns 502 when container start fails', async () => {
    process.env.HOST_DATA_DIR = '/host/data';
    httpScript.queue = [
      { statusCode: 200 },                                  // /_ping
      { statusCode: 200 },                                  // imageExists hadBefore
      { statusCode: 200 },                                  // pullImage ok
      { statusCode: 200 },                                  // imageExists present
      { statusCode: 200, json: { State: { Running: false } } }, // containerState stopped
      // removeContainer (DELETE) -> one call
      { statusCode: 204 },                                  // remove
      { statusCode: 201, json: { Id: 'c' } },               // create
      { statusCode: 500, json: { message: 'boom' } },       // start fails
    ];
    const res = await request(app).post('/api/update/start').set('x-confirm-update', 'yes');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('start_failed');
    // Docker engine error body ({ message: 'boom' }) must not leak to the client.
    expect(res.body).not.toHaveProperty('detail');
  });
});

describe('GET /api/update/state', () => {
  it('reports running/available state', async () => {
    process.env.HOST_DATA_DIR = '/host/data';
    httpScript.queue = [
      { statusCode: 200, json: { State: { Running: true } } }, // containerState
      { statusCode: 200 },                                     // imageExists
      { statusCode: 200 },                                     // dockerSocketReachable /_ping
    ];
    const res = await request(app).get('/api/update/state');
    expect(res.status).toBe(200);
    expect(res.body.running).toBe(true);
    expect(res.body.updaterAvailable).toBe(true);
    expect(res.body.socketReachable).toBe(true);
    expect(res.body.hostPathsConfigured).toBe(true);
    expect(res.body.canStart).toBe(false); // running → cannot start
  });

  it('reports canStart true when not running and prerequisites met', async () => {
    process.env.HOST_DATA_DIR = '/host/data';
    httpScript.queue = [
      { statusCode: 404 },  // containerState absent
      { statusCode: 200 },  // imageExists
      { statusCode: 200 },  // socket reachable
    ];
    const res = await request(app).get('/api/update/state');
    expect(res.body.running).toBe(false);
    expect(res.body.canStart).toBe(true);
  });
});

describe('GET /api/update/stream (SSE)', () => {
  it('sets SSE headers and emits a connected event', async () => {
    // No existing status log -> pump returns early. fs.watch is mocked.
    mockFs.existsSync.mockReturnValue(false);
    const res = await request(app)
      .get('/api/update/stream')
      .buffer(true)
      // SSE never ends; resolve on the first chunk and tear the request down so
      // the route's req.on('close') clears its timers (no open handles).
      .parse((response: any, callback: any) => {
        let data = '';
        response.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          response.destroy();
          callback(null, data);
        });
        response.on('error', () => callback(null, data));
        response.on('end', () => callback(null, data));
      });
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('connected');
  });

  it('pumps existing log content as phase and log events', async () => {
    const logContent = 'PHASE:pulling:image\nplain log line\n';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({ size: logContent.length } as any);
    mockFs.readSync.mockImplementation((_fd: number, buf: Buffer) => {
      buf.write(logContent);
      return logContent.length;
    });
    // Drive fs.watch: invoke the registered callback so the watch branch runs.
    mockFs.watch.mockImplementation((_dir: string, cb: any) => {
      setImmediate(() => cb('change', 'update-status.log'));
      return { close: vi.fn() };
    });

    const res = await request(app)
      .get('/api/update/stream')
      .buffer(true)
      .parse((response: any, callback: any) => {
        let data = '';
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          response.destroy();
          callback(null, data);
        };
        response.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          setTimeout(finish, 30);
        });
        response.on('error', finish);
        response.on('end', finish);
      });
    expect(res.body).toContain('event: phase');
    expect(res.body).toContain('pulling:image');
    expect(res.body).toContain('event: log');
  });

  it('handles a pump read error gracefully', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockImplementation(() => { throw new Error('stat fail'); });
    const res = await request(app)
      .get('/api/update/stream')
      .buffer(true)
      .parse((response: any, callback: any) => {
        let data = '';
        response.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          response.destroy();
          callback(null, data);
        });
        response.on('error', () => callback(null, data));
        response.on('end', () => callback(null, data));
      });
    // connected still sent; pump error is swallowed/logged
    expect(res.body).toContain('connected');
  });
});

describe('ensureUpdaterImage (exported helper)', () => {
  it('returns available+pulled when image freshly pulled', async () => {
    const { ensureUpdaterImage } = await import('../../src/api/routes/update');
    httpScript.queue = [
      { statusCode: 404 }, // imageExists hadBefore=false
      { statusCode: 200 }, // pullImage ok
      { statusCode: 200 }, // imageExists present
    ];
    const result = await ensureUpdaterImage();
    expect(result).toEqual({ available: true, pulled: true });
  });

  it('falls back to cached image when pull fails but image present', async () => {
    const { ensureUpdaterImage } = await import('../../src/api/routes/update');
    httpScript.queue = [
      { statusCode: 200 }, // imageExists hadBefore=true
      { statusCode: 500 }, // pullImage fails
    ];
    const result = await ensureUpdaterImage();
    expect(result).toEqual({ available: true, pulled: false, error: 'pull_failed_using_cache' });
  });

  it('returns unavailable when no image and pull fails', async () => {
    const { ensureUpdaterImage } = await import('../../src/api/routes/update');
    httpScript.queue = [
      { statusCode: 404 }, // imageExists hadBefore=false
      { statusCode: 500 }, // pullImage fails
    ];
    const result = await ensureUpdaterImage();
    expect(result).toEqual({ available: false, pulled: false, error: 'pull_failed' });
  });
});
