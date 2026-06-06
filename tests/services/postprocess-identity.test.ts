import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Same inert-import setup as postprocess-size.test.ts: postprocess.ts pulls in
// the DB layer and several services at module load, so those are mocked while
// fs/path stay real (enumerateEpisodeFiles stats actual files).
vi.mock('../../src/database/index', () => ({ getSetting: vi.fn(() => ''), db: {} }));
vi.mock('../../src/database/services/movies', () => ({
  getAllMovies: vi.fn(() => []), updateMovieStatus: vi.fn(), incrementRetryCount: vi.fn(),
}));
vi.mock('../../src/database/services/downloads', () => ({
  getDownloadsByMovieIds: vi.fn(() => []), updateDownloadStatusByMovieId: vi.fn(),
}));
vi.mock('../../src/database/services/blocklist', () => ({
  addBlocklistEntry: vi.fn(), isReleaseBlocklisted: vi.fn(() => false),
}));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: vi.fn() }));
vi.mock('../../src/database/services/seasons', () => ({
  getSeasonsByShowId: vi.fn(() => []), updateSeasonStatus: vi.fn(),
}));
vi.mock('../../src/database/services/episodes', () => ({ markAllEpisodesDownloaded: vi.fn() }));
vi.mock('../../src/jdownloader/index', () => ({ jdownloaderService: {} }));
vi.mock('../../src/services/libraryProvider', () => ({
  getLibraryProvider: vi.fn(() => ({ isConfigured: () => false })), getLibraryProviderName: vi.fn(() => 'Jellyfin'),
}));
vi.mock('../../src/services/trakt', () => ({ traktService: {} }));
vi.mock('../../src/services/telegram', () => ({ sendTelegramNotification: vi.fn() }));
vi.mock('../../src/services/eventbus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn() } }));
vi.mock('../../src/services/scheduler', () => ({ processingMovies: new Set() }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  enumerateEpisodeFiles,
  pickEpisodeFiles,
  sweepStaleLibraryParts,
  splitTitleYear,
  folderMatchesShow,
  isConfirmedInLibrary,
  moveCompanionSubtitles,
  nameStartsWithShowTitle,
} from '../../src/services/postprocess';

const show = (title: string, year?: number) => ({ title, year: year ?? null }) as any;

describe('folderMatchesShow — a show must not claim a sibling title', () => {
  it('does not let "Dark" match "Dark Meridian"', () => {
    expect(folderMatchesShow('Dark.Meridian.S01E01.GERMAN.1080p.WEB.h264-GRP', show('Dark'), [])).toBe(false);
  });

  it('still matches its own episode folder', () => {
    expect(folderMatchesShow('Dark.S01E01.GERMAN.1080p.WEB.h264-GRP', show('Dark'), [])).toBe(true);
  });

  it('does not let the numeric title "24" match every h264 release', () => {
    expect(folderMatchesShow('The.Novice.S05E17.GERMAN.1080p.h264-GRP', show('17'), [])).toBe(false);
    expect(folderMatchesShow('17.S01E01.GERMAN.1080p.h264-GRP', show('17'), [])).toBe(true);
  });

  it('tolerates a production year or country tag between title and season marker', () => {
    expect(folderMatchesShow('Der.Pass.2018.S01E01.GERMAN.1080p', show('Der Pass'), [])).toBe(true);
    expect(folderMatchesShow('The.Office.US.S01E01.1080p', show('The Office'), [])).toBe(true);
  });

  it('matches via the recorded release name even when the title differs cosmetically', () => {
    const downloads = [{ release_name: 'Dark.Meridian.S01.COMPLETE.GERMAN.1080p' }] as any;
    expect(folderMatchesShow('Dark.Meridian.S01E03.GERMAN.1080p', show('Dark Meridian'), downloads)).toBe(true);
  });

  it('rejects an unrelated folder that shares no title', () => {
    expect(folderMatchesShow('Salt.Ledger.S01E01.1080p', show('Salt Harbor'), [])).toBe(false);
  });
});

describe('nameStartsWithShowTitle — boundary rule for names without a season marker', () => {
  it('accepts an exact title and a title plus qualifier', () => {
    expect(nameStartsWithShowTitle('Dark', 'dark')).toBe(true);
    expect(nameStartsWithShowTitle('Dark (2017) - S01 - 1080p', 'dark')).toBe(true);
  });

  it('rejects a longer sibling title', () => {
    expect(nameStartsWithShowTitle('Dark Meridian (2024) - S01 - 1080p', 'dark')).toBe(false);
  });

  it('accepts a library folder carrying a provider-id marker', () => {
    // Jellyfin/Plex convention, and what the series-folder default writes since
    // 2026-08-26. Rejecting it would switch off findShowDir (Endkontrolle) and
    // isConfirmedInLibrary (leftover cleanup) for that show without a word.
    expect(nameStartsWithShowTitle('Wardline [imdbid-tt0000101]', 'wardline')).toBe(true);
    expect(nameStartsWithShowTitle('Dark [tvdbid-70336]', 'dark')).toBe(true);
    expect(nameStartsWithShowTitle('Grell [tmdbid-100303]', 'grell')).toBe(true);
  });

  it('still keeps a sibling apart when both carry id markers', () => {
    expect(nameStartsWithShowTitle('Dark Meridian [imdbid-tt9102177]', 'dark')).toBe(false);
  });
});

describe('enumerateEpisodeFiles — small files stay visible', () => {
  let tmp: string;
  const MB = 1024 * 1024;

  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-ep-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const write = (name: string, sizeMB: number) => {
    fs.writeFileSync(path.join(tmp, name), Buffer.alloc(Math.round(sizeMB * MB)));
  };

  it('reports sub-threshold episodes instead of dropping them silently', () => {
    write('Show.S01E01.mkv', 1);
    write('Show.S01E02.mkv', 8);
    const out = enumerateEpisodeFiles(tmp, 'Show.S01.COMPLETE', 5);

    // Both files come back — the small one flagged, not omitted. Omitting it made
    // the caller believe the folder was fully drained and delete it.
    expect(out).toHaveLength(2);
    const e1 = out.find(c => c.file.endsWith('S01E01.mkv'))!;
    const e2 = out.find(c => c.file.endsWith('S01E02.mkv'))!;
    expect(e1.belowThreshold).toBe(true);
    expect(e2.belowThreshold).toBe(false);
    expect(e1.episode).toBe(1);
    expect(e2.episode).toBe(2);
  });

  it('inherits the season from the folder name when the file omits it', () => {
    write('E04.mkv', 8);
    const out = enumerateEpisodeFiles(tmp, 'Show.S03.COMPLETE.GERMAN', 5);
    expect(out).toHaveLength(1);
    expect(out[0].season).toBe(3);
  });

  it('ignores non-media files entirely', () => {
    write('Show.S01E01.mkv', 8);
    fs.writeFileSync(path.join(tmp, 'readme.nfo'), 'x');
    const out = enumerateEpisodeFiles(tmp, 'Show.S01', 5);
    expect(out).toHaveLength(1);
  });
});

describe('moveCompanionSubtitles — external subs survive the move', () => {
  let src: string;
  let dst: string;

  beforeEach(() => {
    src = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-subsrc-'));
    dst = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-subdst-'));
  });
  afterEach(() => {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });

  it('carries a sibling subtitle across and renames it to match the video', async () => {
    // The movers relocate only the video and then delete the container, so
    // separate forced subs — routine on German releases — were destroyed with it.
    const video = path.join(src, 'Movie.2024.GERMAN.1080p.mkv');
    fs.writeFileSync(video, 'video');
    fs.writeFileSync(path.join(src, 'Movie.2024.GERMAN.1080p.ger.forced.srt'), 'subs');
    const dest = path.join(dst, 'Movie (2024).mkv');

    const moved = await moveCompanionSubtitles(video, dest);

    expect(moved).toBe(1);
    expect(fs.existsSync(path.join(dst, 'Movie (2024).ger.forced.srt'))).toBe(true);
  });

  it('also picks up a Subs/ subfolder', async () => {
    const video = path.join(src, 'Movie.mkv');
    fs.writeFileSync(video, 'video');
    fs.mkdirSync(path.join(src, 'Subs'));
    fs.writeFileSync(path.join(src, 'Subs', 'german.srt'), 'subs');
    const dest = path.join(dst, 'Movie (2024).mkv');

    const moved = await moveCompanionSubtitles(video, dest);

    expect(moved).toBe(1);
    expect(fs.existsSync(path.join(dst, 'Movie (2024).german.srt'))).toBe(true);
  });

  it('leaves non-subtitle files alone', async () => {
    const video = path.join(src, 'Movie.mkv');
    fs.writeFileSync(video, 'video');
    fs.writeFileSync(path.join(src, 'readme.nfo'), 'x');
    const dest = path.join(dst, 'Movie (2024).mkv');

    const moved = await moveCompanionSubtitles(video, dest);

    expect(moved).toBe(0);
    expect(fs.existsSync(path.join(src, 'readme.nfo'))).toBe(true);
  });

  it('does not overwrite a subtitle already in the library', async () => {
    const video = path.join(src, 'Movie.mkv');
    fs.writeFileSync(video, 'video');
    fs.writeFileSync(path.join(src, 'Movie.srt'), 'new');
    fs.writeFileSync(path.join(dst, 'Movie (2024).srt'), 'existing');
    const dest = path.join(dst, 'Movie (2024).mkv');

    const moved = await moveCompanionSubtitles(video, dest);

    expect(moved).toBe(0);
    expect(fs.readFileSync(path.join(dst, 'Movie (2024).srt'), 'utf8')).toBe('existing');
  });
});

describe('isConfirmedInLibrary — subtitle sidecars beside the video', () => {
  let lib: string;
  beforeEach(() => { lib = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-lib-')); });
  afterEach(() => { fs.rmSync(lib, { recursive: true, force: true }); });

  const film = { title: 'Stiller Hafen', year: 2014, media_type: 'movie' } as any;
  const touch = (name: string) => fs.writeFileSync(path.join(lib, name), 'x');

  it('finds the video even when a sidecar sorts before it', () => {
    // readdir order is the filesystem's, not ours — the "-eng.idx" sidecar can
    // come back first, and the first name match used to be the only one tested.
    touch('Stiller Hafen (2014)-eng.idx');
    touch('Stiller Hafen (2014)-eng.sub');
    touch('Stiller Hafen (2014).mkv');
    expect(isConfirmedInLibrary(film, lib, null)).toBe(true);
  });

  it('does not mistake sidecars alone for a present film', () => {
    touch('Stiller Hafen (2014)-eng.idx');
    touch('Stiller Hafen (2014).sub');
    expect(isConfirmedInLibrary(film, lib, null)).toBe(false);
  });

  it('still accepts a folder layout holding the media file', () => {
    fs.mkdirSync(path.join(lib, 'Stiller Hafen (2014)'));
    fs.writeFileSync(path.join(lib, 'Stiller Hafen (2014)', 'Stiller Hafen (2014).mkv'), 'x');
    expect(isConfirmedInLibrary(film, lib, null)).toBe(true);
  });

  it('does not confirm a longer title of the same year', () => {
    touch('Stiller Hafen Zwei (2014).mkv');
    expect(isConfirmedInLibrary(film, lib, null)).toBe(false);
  });

  it('confirms a hand-made release folder whose name starts with the title and year', () => {
    fs.mkdirSync(path.join(lib, 'Stiller.Hafen.2014.German.DL.1080p.BluRay-GRP'));
    fs.writeFileSync(path.join(lib, 'Stiller.Hafen.2014.German.DL.1080p.BluRay-GRP', 'stiller.hafen.mkv'), 'x');
    expect(isConfirmedInLibrary(film, lib, null)).toBe(true);
  });

  it('confirms a folder that carries the title after a " - " prefix', () => {
    fs.mkdirSync(path.join(lib, 'A Special Presentation - Stiller Hafen (2014)'));
    fs.writeFileSync(path.join(lib, 'A Special Presentation - Stiller Hafen (2014)', 'x.mkv'), 'x');
    expect(isConfirmedInLibrary(film, lib, null)).toBe(true);
  });

  it('does not count a folder that only holds the sample', () => {
    // The film was gone, Sample/…-sample.mkv kept the title "in the library".
    fs.mkdirSync(path.join(lib, 'Stiller Hafen (2014)', 'Sample'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'Stiller Hafen (2014)', 'Sample', 'stiller.hafen.2014-sample.mkv'), 'x');
    fs.writeFileSync(path.join(lib, 'Stiller Hafen (2014)', 'stiller.hafen.2014.nfo'), 'x');
    expect(isConfirmedInLibrary(film, lib, null)).toBe(false);
  });

  it('checks every match, not just the first: an empty folder beside the real file', () => {
    fs.mkdirSync(path.join(lib, 'Stiller Hafen (2014)'));
    touch('Stiller Hafen (2014).mp4');
    expect(isConfirmedInLibrary(film, lib, null)).toBe(true);
  });

  it('confirms a show through its series folder', () => {
    fs.mkdirSync(path.join(lib, 'Dunkel', 'Season 01'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'Dunkel', 'Season 01', 'Dunkel S01E01.mkv'), 'x');
    expect(isConfirmedInLibrary({ title: 'Dunkel', year: 2017, media_type: 'show' } as any, null, lib)).toBe(true);
  });
});

describe('pickEpisodeFiles — one file per episode', () => {
  let tmp: string;
  const MB = 1024 * 1024;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-pick-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const write = (rel: string, sizeMB: number) => {
    const f = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(Math.round(sizeMB * MB)));
    return f;
  };

  it('drops a sample that maps to the same episode, even when listed first', () => {
    const sample = write('Sample/wardline.s04e01.german.dl.1080p-grp-sample.mkv', 3);
    const real = write('Wardline.S04E01.German.DL.1080p.BluRay.x264-GRP.mkv', 2);
    const cands = [
      { file: sample, season: 4, episode: 1, belowThreshold: false },
      { file: real, season: 4, episode: 1, belowThreshold: false },
    ];
    const { keep, duplicates } = pickEpisodeFiles(cands);
    // Larger sample still loses: it is a sample.
    expect(keep.map(c => c.file)).toEqual([real]);
    expect(duplicates.map(c => c.file)).toEqual([sample]);
  });

  it('keeps the largest of several non-sample files for one episode', () => {
    const small = write('Wardline.S04E02.extra.mkv', 1);
    const big = write('Wardline.S04E02.mkv', 4);
    const { keep } = pickEpisodeFiles([
      { file: small, season: 4, episode: 2, belowThreshold: false },
      { file: big, season: 4, episode: 2, belowThreshold: false },
    ]);
    expect(keep.map(c => c.file)).toEqual([big]);
  });

  it('keeps a lone sample, unmapped files, and sorts by episode', () => {
    const lone = write('Sample/wardline.s01e03-sample.mkv', 1);
    const e2 = write('Wardline.S01E02.mkv', 2);
    const odd = write('bonus.mkv', 2);
    const { keep, duplicates } = pickEpisodeFiles([
      { file: lone, season: 1, episode: 3, belowThreshold: false },
      { file: odd, season: null, episode: null, belowThreshold: false },
      { file: e2, season: 1, episode: 2, belowThreshold: false },
    ]);
    expect(duplicates).toHaveLength(0);
    expect(keep.map(c => c.file)).toEqual([e2, lone, odd]);
  });
});

describe('sweepStaleLibraryParts', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlvault-parts-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const touch = (rel: string, ageH: number) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    const t = (Date.now() - ageH * 3600_000) / 1000;
    fs.utimesSync(f, t, t);
    return f;
  };

  it('removes old interrupted copies at any library depth and keeps fresh ones and real files', () => {
    const oldMovie = touch('Grell (2024).mkv.dlvault-part', 20);
    const oldEp = touch('Sandmere (2023)/Season 1/Sandmere S01E01.mkv.dlvault-part', 30);
    const fresh = touch('Wardline (2025).mkv.dlvault-part', 1);
    const real = touch('Lanternfall (2022).mkv', 100);
    expect(sweepStaleLibraryParts([root, root, undefined])).toBe(2);
    expect(fs.existsSync(oldMovie)).toBe(false);
    expect(fs.existsSync(oldEp)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(real)).toBe(true);
  });
});

describe('titles that contain a year-like number', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-yr-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('splits library and release names on the real year, not the first number', () => {
    expect(splitTitleYear('Wardline 2049 (2017).mkv')).toEqual({ title: 'wardline 2049', year: '2017' });
    expect(splitTitleYear('2087 (2019).mkv')).toEqual({ title: '2087', year: '2019' });
    expect(splitTitleYear('Wardline.2049.2017.German.DL.1080p.WEB.h264-GRP')).toEqual({ title: 'wardline 2049', year: '2017' });
    expect(splitTitleYear('2087.2019.German.DL.1080p-GRP').title).toBe('2087');
    expect(splitTitleYear('Grell (2024).mkv')).toEqual({ title: 'grell', year: '2024' });
    expect(splitTitleYear('Grell.2024.German.DL.2160p-GRP')).toEqual({ title: 'grell', year: '2024' });
    expect(splitTitleYear('2087')).toEqual({ title: '2087', year: null });
  });

  it('finds such films in the library', () => {
    for (const [t, y] of [['Wardline 2049', 2017], ['2087', 2019], ['Grell 1984', 2020], ['2001 Sandmere', 1968]] as const) {
      fs.writeFileSync(path.join(dir, `${t} (${y}).mkv`), '');
      expect(isConfirmedInLibrary({ title: t, year: y, media_type: 'movie' } as any, dir, dir), `${t} (${y})`).toBe(true);
    }
    // …and still never confirms a different film of the same name and another year.
    expect(isConfirmedInLibrary({ title: 'Wardline 2049', year: 1999, media_type: 'movie' } as any, dir, dir)).toBe(false);
  });
});

describe('isConfirmedInLibrary — kids library', () => {
  it('finds a film that lives in the kids folder, only when it is configured', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { getSetting } = await import('../../src/database/index');
    const main = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-main-'));
    const kids = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-kids-'));
    fs.writeFileSync(path.join(kids, 'The Lego Movie (2014).mkv'), 'x');
    const film = { title: 'The Lego Movie', year: 2014, media_type: 'movie' } as any;
    (getSetting as any).mockImplementation((k: string) => (k === 'paths.kids_movies' ? kids : ''));
    expect(isConfirmedInLibrary(film, main, null)).toBe(true);
    (getSetting as any).mockImplementation(() => '');
    expect(isConfirmedInLibrary(film, main, null)).toBe(false);
  });
});
