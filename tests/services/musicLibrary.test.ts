import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockSettings: Record<string, string> = {};
let providerType = 'jellyfin';

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((k: string) => mockSettings[k] ?? ''),
}));
vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProviderType: vi.fn(() => providerType),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  isMusicLibraryConfigured, getMusicAlbums, getMusicAlbumTracks,
  deleteMusicAlbum, invalidateMusicLibraryCache,
} from '../../src/services/musicLibrary';

/** Jellyfin's /Users payload — the admin is the one that should win. */
const USERS = [
  { Id: 'plain-user', Policy: { IsAdministrator: false } },
  { Id: 'admin-user', Policy: { IsAdministrator: true } },
];

const ALBUM = {
  Id: 'alb-1', Name: 'Kid A', ProductionYear: 2000,
  AlbumArtist: 'Radiohead', ImageTags: { Primary: 'tag-1' },
  DateCreated: '2026-08-01T10:00:00Z', ChildCount: 10,
};

function configure(url = 'http://jf:8096', key = 'k1') {
  mockSettings['jellyfin.url'] = url;
  mockSettings['jellyfin.api_key'] = key;
}

/** /Users first, then the item query. */
function respondUsersThen(items: unknown[]) {
  mockedAxios.get
    .mockResolvedValueOnce({ data: USERS } as any)
    .mockResolvedValueOnce({ data: { Items: items } } as any);
}

describe('musicLibrary', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.delete.mockReset();
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    providerType = 'jellyfin';
    invalidateMusicLibraryCache();
  });

  describe('isMusicLibraryConfigured', () => {
    it('needs a Jellyfin provider plus url and key', () => {
      expect(isMusicLibraryConfigured()).toBe(false);
      configure();
      expect(isMusicLibraryConfigured()).toBe(true);
    });

    it('is false for a non-Jellyfin provider even when Jellyfin settings exist', () => {
      configure();
      providerType = 'plex';   // Plex music is not implemented
      expect(isMusicLibraryConfigured()).toBe(false);
    });

    it('is false when the api key is missing', () => {
      mockSettings['jellyfin.url'] = 'http://jf:8096';
      expect(isMusicLibraryConfigured()).toBe(false);
    });
  });

  describe('getMusicAlbums', () => {
    it('returns nothing and makes no request when unconfigured', async () => {
      expect(await getMusicAlbums()).toEqual([]);
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('maps a Jellyfin album onto the shape the UI expects', async () => {
      configure();
      respondUsersThen([ALBUM]);

      expect(await getMusicAlbums()).toEqual([{
        id: 'alb-1', title: 'Kid A', artist: 'Radiohead', year: 2000,
        imageTag: 'tag-1', addedAt: '2026-08-01T10:00:00Z', trackCount: 10,
      }]);
    });

    it('falls back to the first AlbumArtists entry when AlbumArtist is absent', async () => {
      configure();
      respondUsersThen([{ ...ALBUM, AlbumArtist: undefined, AlbumArtists: [{ Name: 'Portishead' }] }]);

      expect((await getMusicAlbums())[0].artist).toBe('Portishead');
    });

    it('nulls the optional fields rather than passing undefined through', async () => {
      configure();
      respondUsersThen([{ Id: 'x', Name: 'Bare' }]);

      expect(await getMusicAlbums()).toEqual([{
        id: 'x', title: 'Bare', artist: null, year: null,
        imageTag: null, addedAt: null, trackCount: null,
      }]);
    });

    it('prefers the administrator account when resolving the user', async () => {
      configure();
      respondUsersThen([ALBUM]);

      await getMusicAlbums();

      expect(mockedAxios.get.mock.calls[1][0]).toBe('http://jf:8096/Users/admin-user/Items');
    });

    it('queries the unscoped endpoint when no user can be resolved', async () => {
      configure();
      mockedAxios.get
        .mockRejectedValueOnce(new Error('401'))                      // /Users fails
        .mockResolvedValueOnce({ data: { Items: [ALBUM] } } as any);

      await getMusicAlbums();

      expect(mockedAxios.get.mock.calls[1][0]).toBe('http://jf:8096/Items');
    });

    it('serves the cache on the next call and refetches when forced', async () => {
      configure();
      respondUsersThen([ALBUM]);
      await getMusicAlbums();
      const afterFirst = mockedAxios.get.mock.calls.length;

      await getMusicAlbums();
      expect(mockedAxios.get.mock.calls.length).toBe(afterFirst);   // served from cache

      mockedAxios.get.mockResolvedValueOnce({ data: { Items: [] } } as any);
      expect(await getMusicAlbums(true)).toEqual([]);
    });

    it('drops the cache when a finished download invalidates it', async () => {
      configure();
      respondUsersThen([ALBUM]);
      await getMusicAlbums();

      invalidateMusicLibraryCache();
      // The invalidation drops the resolved user as well, so /Users is re-fetched.
      respondUsersThen([]);

      expect(await getMusicAlbums()).toEqual([]);
    });

    it('re-resolves the user after the Jellyfin instance changes', async () => {
      // The id used to be memoized for the process lifetime with nothing clearing
      // it, so repointing at another Jellyfin kept addressing a user that server
      // has never heard of — the Musik tab stayed empty until a restart.
      configure('http://old:8096', 'k1');
      respondUsersThen([ALBUM]);
      await getMusicAlbums();

      configure('http://new:8096', 'k2');
      invalidateMusicLibraryCache();
      mockedAxios.get
        .mockResolvedValueOnce({ data: [{ Id: 'other-admin', Policy: { IsAdministrator: true } }] } as any)
        .mockResolvedValueOnce({ data: { Items: [ALBUM] } } as any);

      await getMusicAlbums();

      const last = mockedAxios.get.mock.calls.at(-1)![0];
      expect(last).toBe('http://new:8096/Users/other-admin/Items');
    });
  });

  describe('getMusicAlbumTracks', () => {
    it('returns nothing when unconfigured', async () => {
      expect(await getMusicAlbumTracks('alb-1')).toEqual([]);
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('maps tracks and converts ticks to seconds', async () => {
      configure();
      respondUsersThen([
        { Id: 't1', Name: 'Everything In Its Right Place', IndexNumber: 1, ParentIndexNumber: 1, RunTimeTicks: 2_530_000_000 },
      ]);

      expect(await getMusicAlbumTracks('alb-1')).toEqual([
        { id: 't1', title: 'Everything In Its Right Place', track: 1, disc: 1, durationSec: 253 },
      ]);
    });

    it('names an untitled track by its position', async () => {
      configure();
      respondUsersThen([{ Id: 't1' }, { Id: 't2' }]);

      const tracks = await getMusicAlbumTracks('alb-1');
      expect(tracks.map(t => t.title)).toEqual(['Track 1', 'Track 2']);
      expect(tracks[0]).toMatchObject({ track: null, disc: null, durationSec: null });
    });

    it('scopes the query to the requested album', async () => {
      configure();
      respondUsersThen([]);

      await getMusicAlbumTracks('alb-42');

      expect(mockedAxios.get.mock.calls[1][1]).toMatchObject({
        params: expect.objectContaining({ ParentId: 'alb-42', IncludeItemTypes: 'Audio' }),
      });
    });
  });

  describe('deleteMusicAlbum', () => {
    it('refuses when the library is not configured', async () => {
      await expect(deleteMusicAlbum('alb-1')).rejects.toThrow(/nicht konfiguriert/);
      expect(mockedAxios.delete).not.toHaveBeenCalled();
    });

    it('deletes through Jellyfin and drops the cache', async () => {
      configure();
      respondUsersThen([ALBUM]);
      await getMusicAlbums();

      mockedAxios.delete.mockResolvedValueOnce({} as any);
      await deleteMusicAlbum('alb-1');

      expect(mockedAxios.delete).toHaveBeenCalledWith(
        'http://jf:8096/Items/alb-1', expect.objectContaining({
          headers: { 'X-Emby-Token': 'k1' },
        }));

      // Cache gone: the next read hits Jellyfin again.
      mockedAxios.get.mockResolvedValueOnce({ data: { Items: [] } } as any);
      expect(await getMusicAlbums()).toEqual([]);
    });

    it('escapes the id so a traversal cannot retarget the request', async () => {
      // The id arrives as a route param and Express decodes %2F inside a segment,
      // so "../Users/x" would resolve against the base URL and fire the DELETE at
      // a different Jellyfin endpoint — with the admin token attached.
      configure();
      mockedAxios.delete.mockResolvedValueOnce({} as any);

      await deleteMusicAlbum('../Users/admin-user');

      expect(mockedAxios.delete.mock.calls[0][0]).toBe(
        'http://jf:8096/Items/..%2FUsers%2Fadmin-user');
    });
  });
});
