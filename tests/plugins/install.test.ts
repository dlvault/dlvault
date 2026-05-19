import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('axios', () => ({ default: { get: mockGet } }));

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

import {
  installFromUrl,
  installFromBuffer,
  acceptPendingPlugin,
  uninstallPlugin,
  InstallError,
} from '../../src/plugins/install';
import { pluginRegistry } from '../../src/plugins/registry';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-install-test-'));

const validPlugin = `
module.exports.manifest = {
  id: 'test-source',
  name: 'Test Source',
  version: '1.0.0',
  mediaTypes: ['movie'],
};
module.exports.default = function (ctx) {
  return {
    id: 'test-source',
    name: 'Test Source',
    mediaTypes: ['movie'],
    async findReleases() { return { sourceUrl: null, releases: [] }; },
    async resolveLinks(links) { return links; },
  };
};
`;

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  pluginRegistry._reset();
  mockGet.mockReset();
  for (const f of fs.readdirSync(tmpDir)) {
    fs.unlinkSync(path.join(tmpDir, f));
  }
});

describe('installFromBuffer', () => {
  it('rejects without disclaimer', async () => {
    await expect(installFromBuffer('plugin.dlvault.js', Buffer.from(validPlugin), {
      disclaimerAccepted: false,
      pluginsDir: tmpDir,
    })).rejects.toThrow(/disclaimerAccepted must be true/);
  });

  it('rejects a file not ending in .dlvault.js', async () => {
    await expect(installFromBuffer('plugin.js', Buffer.from(validPlugin), {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    })).rejects.toThrow(/\.dlvault\.js/);
  });

  it('installs a valid plugin, records disclaimer, registers', async () => {
    const result = await installFromBuffer('plugin.dlvault.js', Buffer.from(validPlugin), {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    });
    expect(result.manifest.id).toBe('test-source');
    expect(fs.existsSync(path.join(tmpDir, 'test-source.dlvault.js'))).toBe(true);
    const log = JSON.parse(fs.readFileSync(path.join(tmpDir, 'disclaimer-log.json'), 'utf-8'));
    expect(log['test-source']).toBeDefined();
    expect(log['test-source'].fileSha256).toBe(result.fileSha256);
    expect(pluginRegistry.getById('test-source')).toBeDefined();
  });

  it('refuses to overwrite a bundled plugin id', async () => {
    pluginRegistry.registerBundled({
      id: 'test-source',
      name: 'bundled',
      mediaTypes: ['movie'],
      findReleases: async () => ({ sourceUrl: null, releases: [] }),
      resolveLinks: async (l) => l,
    });
    await expect(installFromBuffer('plugin.dlvault.js', Buffer.from(validPlugin), {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    })).rejects.toThrow(/reserved by a bundled plugin/);
  });

  it('rejects an invalid manifest', async () => {
    const broken = `module.exports.manifest = { id: 'INVALID_ID', name: 'x', version: '1.0.0', mediaTypes: ['movie'] };
                    module.exports.default = () => ({});`;
    await expect(installFromBuffer('plugin.dlvault.js', Buffer.from(broken), {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    })).rejects.toThrow(/invalid manifest/);
  });

  it('rolls back the file when the factory throws', async () => {
    const throwingPlugin = `
      module.exports.manifest = {
        id: 'thrower', name: 'T', version: '1.0.0', mediaTypes: ['movie'],
      };
      module.exports.default = () => { throw new Error('boom'); };
    `;
    await expect(installFromBuffer('plugin.dlvault.js', Buffer.from(throwingPlugin), {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    })).rejects.toThrow(/factory threw/);
    expect(fs.existsSync(path.join(tmpDir, 'thrower.dlvault.js'))).toBe(false);
  });
});

describe('installFromUrl', () => {
  it('rejects non-https URLs', async () => {
    await expect(installFromUrl('http://example.com/p.js', {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    })).rejects.toThrow(/https:\/\//);
  });

  it('rejects cloud metadata endpoints (SSRF guard) without fetching', async () => {
    mockGet.mockClear();
    await expect(installFromUrl('https://169.254.169.254/latest/meta-data/', {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    })).rejects.toThrow(/metadata/i);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('downloads and installs a valid plugin', async () => {
    mockGet.mockResolvedValueOnce({ data: Buffer.from(validPlugin) });
    const result = await installFromUrl('https://example.com/plugin.dlvault.js', {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    });
    expect(result.sourceUrl).toBe('https://example.com/plugin.dlvault.js');
    expect(result.manifest.id).toBe('test-source');
    expect(pluginRegistry.getById('test-source')).toBeDefined();
  });

  it('surfaces a 502 when the download fails', async () => {
    mockGet.mockRejectedValueOnce(new Error('connection refused'));
    await expect(installFromUrl('https://example.com/plugin.dlvault.js', {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    })).rejects.toMatchObject({ status: 502 });
  });
});

describe('acceptPendingPlugin', () => {
  it('accepts a file that is already on disk', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test-source.dlvault.js'), validPlugin);
    const result = await acceptPendingPlugin('test-source', {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    });
    expect(result.manifest.id).toBe('test-source');
    expect(pluginRegistry.getById('test-source')).toBeDefined();
  });

  it('404s when no such file exists', async () => {
    await expect(acceptPendingPlugin('nonexistent', {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    })).rejects.toMatchObject({ status: 404 });
  });

  it('refuses if the file declares a different id', async () => {
    fs.writeFileSync(path.join(tmpDir, 'expected.dlvault.js'), validPlugin);
    await expect(acceptPendingPlugin('expected', {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    })).rejects.toThrow(/declares plugin id/);
  });
});

describe('uninstallPlugin', () => {
  it('removes the plugin from registry, file, and disclaimer log', async () => {
    await installFromBuffer('plugin.dlvault.js', Buffer.from(validPlugin), {
      disclaimerAccepted: true,
      pluginsDir: tmpDir,
    });
    expect(pluginRegistry.getById('test-source')).toBeDefined();
    uninstallPlugin('test-source', tmpDir);
    expect(pluginRegistry.getById('test-source')).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, 'test-source.dlvault.js'))).toBe(false);
    const log = JSON.parse(fs.readFileSync(path.join(tmpDir, 'disclaimer-log.json'), 'utf-8'));
    expect(log['test-source']).toBeUndefined();
  });

  it('refuses to uninstall a bundled plugin', () => {
    pluginRegistry.registerBundled({
      id: 'bundled-x',
      name: 'b',
      mediaTypes: ['movie'],
      findReleases: async () => ({ sourceUrl: null, releases: [] }),
      resolveLinks: async (l) => l,
    });
    expect(() => uninstallPlugin('bundled-x', tmpDir)).toThrow(/bundled/);
  });
});
