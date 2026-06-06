import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockEventBus = vi.hoisted(() => ({
  addClient: vi.fn(() => true),
  removeClient: vi.fn(),
}));

vi.mock('../../src/services/eventbus', () => ({
  eventBus: mockEventBus,
}));

import express from 'express';
import http from 'node:http';
import router from '../../src/api/routes/events';

function makeServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/events', router);
  return http.createServer(app);
}

// Helper: open a raw SSE request, collect bytes, then resolve. For the
// keepalive (accepted) case the stream stays open, so we resolve shortly after
// the first chunk and tear the connection down (clears the server-side
// interval via req.on('close')). For the rejected case the server calls
// res.end(), so we also resolve on 'end'.
function openSSE(server: http.Server): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') return reject(new Error('no address'));
    const req = http.request(
      { host: '127.0.0.1', port: addr.port, path: '/api/events', method: 'GET' },
      (res) => {
        let body = '';
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          res.destroy();
          req.destroy();
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body });
        };
        res.on('data', (chunk) => {
          body += chunk.toString();
          // Give the server a tick to flush any follow-up writes (e.g. the
          // error line right after the connected line) before we settle.
          setTimeout(finish, 20);
        });
        res.on('end', finish);
        res.on('error', finish);
      },
    );
    req.on('error', () => { /* ignore abort-induced errors */ });
    req.end();
  });
}

describe('GET /api/events (SSE)', () => {
  let server: http.Server;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventBus.addClient.mockReturnValue(true);
    server = makeServer();
    return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(() => {
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sets SSE headers and sends an initial connected event', async () => {
    const res = await openSSE(server);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.body).toContain('"event":"connected"');
    expect(mockEventBus.addClient).toHaveBeenCalledTimes(1);
  });

  it('sends an error event and ends when too many connections', async () => {
    mockEventBus.addClient.mockReturnValueOnce(false);
    const res = await openSSE(server);
    expect(res.statusCode).toBe(200);
    // initial connected line plus the error line are flushed before res.end()
    expect(res.body).toContain('"event":"error"');
    expect(res.body).toContain('Too many connections');
  });
});
