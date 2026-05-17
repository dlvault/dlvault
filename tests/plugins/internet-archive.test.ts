import { describe, it, expect, vi, beforeEach } from 'vitest';
import iaFactory, { manifest } from '../../src/plugins/internet-archive/index';
import type { PluginContext, PluginHttpResponse } from '../../src/plugins/context';

/**
 * IA-plugin tests through the manifest+factory contract. The plugin never
 * imports axios directly — it only sees what we put in the mock context.
 * That's exactly the pattern external plugin authors will use, so this test
 * doubles as the reference for plugin-author testing.
 */

interface MockContext extends PluginContext {
  __httpGet: ReturnType<typeof vi.fn>;
}

function makeContext(): MockContext {
  const httpGet = vi.fn();
  const ctx: MockContext = {
    pluginId: manifest.id,
    logger: {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    },
    http: {
      get: (url, config) => httpGet(url, config) as Promise<PluginHttpResponse<unknown>>,
      post: vi.fn(),
    },
    rateLimit: vi.fn().mockResolvedValue(undefined),
    getPluginSetting: vi.fn(() => ''),
    setPluginSetting: vi.fn(),
    QUALITY_RANK: { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 },
    AUDIO_RANK: { '7.1': 4, '5.1': 3, '2.0': 1 },
    __httpGet: httpGet,
  };
  return ctx;
}

function resp<T>(data: T): PluginHttpResponse<T> {
  return { status: 200, data, headers: {} };
}

describe('internet-archive plugin (manifest + factory)', () => {
  let ctx: MockContext;
  let plugin: ReturnType<typeof iaFactory>;

  beforeEach(() => {
    ctx = makeContext();
    plugin = iaFactory(ctx);
  });

  describe('manifest', () => {
    it('declares the public-domain plugin identity', () => {
      expect(manifest.id).toBe('internet-archive');
      expect(manifest.mediaTypes).toEqual(['movie']);
      expect(manifest.cspDomains).toContain('archive.org');
      expect(manifest.permissions).toBeUndefined(); // No browser/captcha needed
    });

    it('plugin id matches manifest id (consistency)', () => {
      expect(plugin.id).toBe(manifest.id);
    });
  });

  describe('findReleases', () => {
    it('returns an empty release set for show queries', async () => {
      const result = await plugin.findReleases({ title: 'Anything', mediaType: 'show' });
      expect(result).toEqual({ sourceUrl: null, releases: [] });
      expect(ctx.__httpGet).not.toHaveBeenCalled();
    });

    it('matches a search result by exact title and year', async () => {
      ctx.__httpGet
        .mockResolvedValueOnce(resp({
          response: {
            docs: [
              { identifier: 'night_of_the_living_dead', title: 'Night of the Living Dead', year: 1968 },
              { identifier: 'unrelated', title: 'Some Other Film', year: 1970 },
            ],
          },
        }))
        .mockResolvedValueOnce(resp({
          metadata: { identifier: 'night_of_the_living_dead', title: 'Night of the Living Dead' },
          files: [
            { name: 'NotLD_1080p.mp4', format: 'h.264', size: '2500000000' },
            { name: 'NotLD_720p.mp4', format: 'h.264', size: '900000000' },
            { name: 'NotLD.srt', format: 'SubRip', size: '40000' },
          ],
        }));

      const result = await plugin.findReleases({
        title: 'Night of the Living Dead', year: 1968, mediaType: 'movie',
      });

      expect(result.sourceUrl).toContain('archive.org/details/night_of_the_living_dead');
      expect(result.releases).toHaveLength(2);
      const qualities = result.releases.map(r => r.quality).sort();
      expect(qualities).toEqual(['1080p', '720p']);
      expect(result.releases[0].links[0].hoster).toBe('archive.org');
      expect(result.releases[0].links[0].url).toContain('archive.org/download/');
    });

    it('returns empty when no result matches title+year', async () => {
      ctx.__httpGet.mockResolvedValueOnce(resp({
        response: { docs: [{ identifier: 'wrong', title: 'Night of the Living Dead', year: 1990 }] },
      }));
      const result = await plugin.findReleases({
        title: 'Night of the Living Dead', year: 1968, mediaType: 'movie',
      });
      expect(result.sourceUrl).toBeNull();
      expect(result.releases).toEqual([]);
    });
  });

  describe('resolveLinks', () => {
    it('is an identity function (archive.org URLs are already direct)', async () => {
      const input = [{ hoster: 'archive.org', url: 'https://archive.org/download/foo/bar.mp4' }];
      expect(await plugin.resolveLinks(input)).toBe(input);
    });
  });

  describe('healthCheck', () => {
    it('returns ok when the sentinel item is found', async () => {
      ctx.__httpGet.mockResolvedValueOnce(resp({
        response: { docs: [{ identifier: 'night_of_the_living_dead', title: 'Night of the Living Dead', year: 1968 }] },
      }));
      const result = await plugin.healthCheck!();
      expect(result.ok).toBe(true);
      expect(result.critical).toBe(false);
    });

    it('fails gracefully when archive.org is unreachable', async () => {
      ctx.__httpGet.mockRejectedValueOnce(new Error('network down'));
      const result = await plugin.healthCheck!();
      expect(result.ok).toBe(false);
      expect(result.critical).toBe(false);
      // The api module catches errors and returns []; the plugin then reports "no results".
      expect(result.error).toMatch(/no results|network down/i);
    });
  });

  describe('searchTitles', () => {
    it('returns up to N candidates', async () => {
      ctx.__httpGet.mockResolvedValueOnce(resp({
        response: {
          docs: [
            { identifier: 'a', title: 'Alpha', year: 1950 },
            { identifier: 'b', title: 'Beta', year: 1960 },
            { identifier: 'c', title: 'Gamma', year: 1970 },
          ],
        },
      }));
      const result = await plugin.searchTitles!('anything', { mediaType: 'movie', limit: 2 });
      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Alpha');
    });

    it('skips show queries', async () => {
      const result = await plugin.searchTitles!('any', { mediaType: 'show' });
      expect(result).toEqual([]);
      expect(ctx.__httpGet).not.toHaveBeenCalled();
    });
  });

  describe('discover', () => {
    it('returns the feature_films discover list and caches', async () => {
      ctx.__httpGet.mockResolvedValueOnce(resp({
        response: {
          docs: Array.from({ length: 10 }, (_, i) => ({
            identifier: `film-${i}`,
            title: `Film ${i}`,
            year: 1950 + i,
            subject: ['drama'],
          })),
        },
      }));
      const first = await plugin.discover!('movie');
      expect(first).toHaveLength(10);
      expect(first[0].rank).toBe(1);

      const cached = plugin.getCachedDiscover!('movie');
      expect(cached).toBe(first);

      // A second call within the TTL should not re-fetch.
      const second = await plugin.discover!('movie');
      expect(ctx.__httpGet).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    });
  });
});
