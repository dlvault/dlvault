import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { crossSiteGuard } from '../../src/utils/crossSiteGuard';

const app = express();
app.use('/api/', crossSiteGuard);
app.all('/api/x', (_req, res) => { res.json({ ok: true }); });

describe('crossSiteGuard', () => {
  it('lets the own UI, scripts and Seerr through', async () => {
    expect((await request(app).post('/api/x').set('Host', '192.168.1.50:3000').set('Origin', 'http://192.168.1.50:3000')).status).toBe(200);
    expect((await request(app).post('/api/x').set('Sec-Fetch-Site', 'same-origin')).status).toBe(200);
    expect((await request(app).post('/api/x')).status).toBe(200);                         // curl / server-to-server
    expect((await request(app).get('/api/x').set('Origin', 'https://evil.example')).status).toBe(200);   // reads stay CORS's job
  });

  it('refuses state changes fired by a foreign page', async () => {
    expect((await request(app).post('/api/x').set('Host', '192.168.1.50:3000').set('Origin', 'https://evil.example')).status).toBe(403);
    expect((await request(app).post('/api/x').set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect((await request(app).delete('/api/x').set('Host', 'nas:3000').set('Origin', 'null')).status).toBe(403);
    expect((await request(app).post('/api/x').set('Host', 'nas:3000').set('Origin', 'http://nas:3001')).status).toBe(403);   // other port = other origin
  });

  it('accepts the origin behind a reverse proxy that forwards the host', async () => {
    expect((await request(app).post('/api/x').set('Host', 'dlvault.example.org').set('Origin', 'https://dlvault.example.org')).status).toBe(200);
    expect((await request(app).post('/api/x').set('Host', '172.17.0.5:3000').set('X-Forwarded-Host', 'dlvault.example.org').set('Origin', 'https://dlvault.example.org')).status).toBe(200);
    // nginx $host drops the port the browser used
    expect((await request(app).post('/api/x').set('Host', 'dlvault.example.org').set('Origin', 'https://dlvault.example.org:18443')).status).toBe(200);
    expect((await request(app).post('/api/x').set('Host', 'dlvault.example.org').set('Origin', 'https://evil.example.org:18443')).status).toBe(403);
  });
});
