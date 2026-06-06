import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const mockSettings: Record<string, string> = {};
vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  setSetting: vi.fn((key: string, value: string) => { mockSettings[key] = value; }),
  default: { prepare: vi.fn() },
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/scraper/rate-limit', () => ({
  waitForRateLimit: vi.fn().mockResolvedValue(undefined),
}));

import { pluginRegistry } from '../../src/plugins/registry';
import { loadPluginsFromDirectory, recordDisclaimerAccepted } from '../../src/plugins/loader';

// Use a single tmp directory across the suite to keep the disk footprint small.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-plugin-test-'));

function writePlugin(filename: string, source: string): string {
  const p = path.join(tmpDir, filename);
  fs.writeFileSync(p, source);
  return p;
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const validPluginSource = `
module.exports.manifest = {
  id: 'demo-source',
  name: 'Demo Source',
  version: '1.0.0',
  mediaTypes: ['movie'],
};
module.exports.default = function (ctx) {
  return {
    id: 'demo-source',
    name: 'Demo Source',
    mediaTypes: ['movie'],
    async findReleases() { return { sourceUrl: null, releases: [] }; },
    async resolveLinks(links) { return links; },
  };
};
`;

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadPluginsFromDirectory', () => {
  beforeEach(() => {
    pluginRegistry._reset();
    // Wipe tmp dir before each test
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
  });

  it('returns empty result for a non-existent directory', () => {
    const r = loadPluginsFromDirectory(path.join(tmpDir, 'nope'));
    expect(r.loaded).toHaveLength(0);
    expect(r.pending).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
  });

  it('marks a valid plugin as pending when no disclaimer accepted', () => {
    writePlugin('demo.dlvault.js', validPluginSource);
    const r = loadPluginsFromDirectory(tmpDir);
    expect(r.loaded).toHaveLength(0);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0].manifest.id).toBe('demo-source');
    expect(r.pending[0].reason).toBe('no-disclaimer');
    expect(pluginRegistry.getById('demo-source')).toBeUndefined();
  });

  it('loads and registers a plugin once disclaimer is recorded', () => {
    const p = writePlugin('demo.dlvault.js', validPluginSource);
    recordDisclaimerAccepted(tmpDir, 'demo-source', {
      acceptedAt: new Date().toISOString(),
      fileSha256: sha256(p),
      manifestVersion: '1.0.0',
    });
    const r = loadPluginsFromDirectory(tmpDir);
    expect(r.loaded).toHaveLength(1);
    expect(r.pending).toHaveLength(0);
    expect(pluginRegistry.getById('demo-source')).toBeDefined();
  });

  it('flags pending when the file hash diverges from the recorded one', () => {
    const p = writePlugin('demo.dlvault.js', validPluginSource);
    recordDisclaimerAccepted(tmpDir, 'demo-source', {
      acceptedAt: new Date().toISOString(),
      fileSha256: 'a'.repeat(64),
      manifestVersion: '1.0.0',
    });
    const r = loadPluginsFromDirectory(tmpDir);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0].reason).toBe('sha-mismatch');
    expect(pluginRegistry.getById('demo-source')).toBeUndefined();
  });

  it('reports a load error for an invalid manifest', () => {
    writePlugin('bad.dlvault.js', `module.exports.manifest = {}; module.exports.default = () => ({});`);
    const r = loadPluginsFromDirectory(tmpDir);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].error).toMatch(/invalid manifest/);
  });

  it('silently skips a plugin id that collides with an already-registered plugin', () => {
    // Collision against the in-memory registry is not an error — it happens
    // legitimately whenever a freshly-installed plugin (registered via the
    // install API) is also on disk and the file-loader runs a second time.
    // The loader logs at debug level and drops the candidate.
    pluginRegistry.register({
      id: 'demo-source',
      name: 'pre-existing',
      mediaTypes: ['movie'],
      findReleases: async () => ({ sourceUrl: null, releases: [] }),
      resolveLinks: async (l) => l,
    });
    const p = writePlugin('demo.dlvault.js', validPluginSource);
    recordDisclaimerAccepted(tmpDir, 'demo-source', {
      acceptedAt: new Date().toISOString(),
      fileSha256: sha256(p),
      manifestVersion: '1.0.0',
    });
    const r = loadPluginsFromDirectory(tmpDir);
    expect(r.loaded).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
    expect(r.pending).toHaveLength(0);
  });

  it('skips files that do not end in .dlvault.js', () => {
    writePlugin('notes.txt', 'hello');
    writePlugin('demo.js', 'module.exports = 1;');
    const r = loadPluginsFromDirectory(tmpDir);
    expect(r.loaded).toHaveLength(0);
    expect(r.pending).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
  });
});
