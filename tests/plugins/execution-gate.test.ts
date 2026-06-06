import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
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
import { previewPlugin, acceptPendingPlugin, uninstallPlugin, InstallError } from '../../src/plugins/install';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-exec-gate-'));

// A plugin whose top-level code leaves an unmistakable trace on disk. If the
// file appears, the host executed code it had not been cleared to execute.
const CANARY = path.join(tmpDir, 'canary.txt');
const sideEffectPlugin = (id: string) => `
require('fs').writeFileSync(${JSON.stringify(CANARY)}, 'executed');
module.exports.manifest = {
  id: '${id}',
  name: 'Side Effect',
  version: '1.0.0',
  mediaTypes: ['movie'],
};
module.exports.default = function () {
  return {
    id: '${id}',
    name: 'Side Effect',
    mediaTypes: ['movie'],
    async findReleases() { return { sourceUrl: null, releases: [] }; },
    async resolveLinks(l) { return l; },
  };
};
`;

function writePlugin(filename: string, source: string): string {
  const p = path.join(tmpDir, filename);
  fs.writeFileSync(p, source);
  return p;
}
function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
const canaryFired = () => fs.existsSync(CANARY);

beforeEach(() => {
  pluginRegistry._reset();
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true });
});
afterEach(() => {
  fs.rmSync(CANARY, { force: true });
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('plugin execution gate — code must not run before it is accepted', () => {
  it('does not execute a dropped-in plugin that has no disclaimer entry', () => {
    writePlugin('evil.dlvault.js', sideEffectPlugin('evil'));

    const result = loadPluginsFromDirectory(tmpDir);

    expect(canaryFired()).toBe(false);
    expect(result.loaded).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0].reason).toBe('no-disclaimer');
    // The UI still gets a usable manifest — read statically, not by running it.
    expect(result.pending[0].manifest.id).toBe('evil');
    expect(result.pending[0].manifest.name).toBe('Side Effect');
  });

  it('does not execute an accepted plugin whose file was modified afterwards', () => {
    const file = writePlugin('tamper.dlvault.js', sideEffectPlugin('tamper'));
    // Accept the ORIGINAL bytes...
    recordDisclaimerAccepted(tmpDir, 'tamper', {
      acceptedAt: new Date().toISOString(),
      fileSha256: sha256File(file),
      manifestVersion: '1.0.0',
    });
    // ...then swap the contents, as an attacker with write access would.
    fs.writeFileSync(file, sideEffectPlugin('tamper').replace("'executed'", "'tampered'"));

    const result = loadPluginsFromDirectory(tmpDir);

    expect(canaryFired()).toBe(false);
    expect(result.loaded).toHaveLength(0);
    expect(result.pending[0].reason).toBe('sha-mismatch');
  });

  it('does execute a plugin that is accepted and unmodified', () => {
    const file = writePlugin('good.dlvault.js', sideEffectPlugin('good'));
    recordDisclaimerAccepted(tmpDir, 'good', {
      acceptedAt: new Date().toISOString(),
      fileSha256: sha256File(file),
      manifestVersion: '1.0.0',
    });

    const result = loadPluginsFromDirectory(tmpDir);

    // The accept IS the authorisation — here running the code is correct.
    expect(result.loaded).toHaveLength(1);
    expect(canaryFired()).toBe(true);
    expect(pluginRegistry.getById('good')).toBeDefined();
  });

  it('does not re-execute an already-registered plugin on a repeat scan', () => {
    const file = writePlugin('again.dlvault.js', sideEffectPlugin('again'));
    recordDisclaimerAccepted(tmpDir, 'again', {
      acceptedAt: new Date().toISOString(),
      fileSha256: sha256File(file),
      manifestVersion: '1.0.0',
    });

    loadPluginsFromDirectory(tmpDir);
    expect(canaryFired()).toBe(true);
    fs.rmSync(CANARY, { force: true });

    // GET /api/plugins rescans the directory on every request — a second pass
    // must not re-enter the plugin's module code.
    loadPluginsFromDirectory(tmpDir);
    expect(canaryFired()).toBe(false);
  });
});

describe('previewPlugin — reads the manifest without running the candidate', () => {
  it('returns the manifest and never executes top-level code', async () => {
    const source = sideEffectPlugin('preview-me');

    const preview = await previewPlugin({ contentBase64: Buffer.from(source).toString('base64') });

    expect(canaryFired()).toBe(false);
    expect(preview.manifest.id).toBe('preview-me');
    expect(preview.fileSha256).toHaveLength(64);
  });

  it('rejects a file whose manifest cannot be read statically', async () => {
    const source = `module.exports.manifest = buildManifest(); module.exports.default = () => ({});`;
    await expect(
      previewPlugin({ contentBase64: Buffer.from(source).toString('base64') }),
    ).rejects.toThrow(InstallError);
    expect(canaryFired()).toBe(false);
  });
});

describe('plugin id path traversal', () => {
  it.each([
    '../../tmp/evil',
    '..%2F..%2Fevil',
    '/etc/passwd',
    'foo/bar',
    '.',
  ])('acceptPendingPlugin rejects the id %j', async (id) => {
    await expect(
      acceptPendingPlugin(id, { disclaimerAccepted: true, pluginsDir: tmpDir }),
    ).rejects.toThrow(/invalid plugin id/);
    expect(canaryFired()).toBe(false);
  });

  it('uninstallPlugin rejects a traversing id instead of unlinking outside the plugins dir', () => {
    const victim = path.join(tmpDir, 'victim.dlvault.js');
    fs.writeFileSync(victim, 'keep me');

    expect(() => uninstallPlugin('../victim', tmpDir)).toThrow(/invalid plugin id/);
    expect(fs.existsSync(victim)).toBe(true);
  });
});
