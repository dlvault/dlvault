import http from 'node:http';

/**
 * Minimal Docker Engine API client over the mounted socket — shared by the
 * self-updater and the JDownloader auto-restart. Every call is explicit; there
 * is no discovery or guessing of container names here.
 */
export const DOCKER_SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';

export function dockerRequest<T = unknown>(
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

