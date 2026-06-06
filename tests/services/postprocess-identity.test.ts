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
  folderMatchesShow,
  moveCompanionSubtitles,
  nameStartsWithShowTitle,
} from '../../src/services/postprocess';

const show = (title: string, year?: number) => ({ title, year: year ?? null }) as any;

describe('folderMatchesShow — a show must not claim a sibling title', () => {
  it('does not let "Dark" match "Dark Matter"', () => {
    expect(folderMatchesShow('Dark.Matter.S01E01.GERMAN.1080p.WEB.h264-GRP', show('Dark'), [])).toBe(false);
  });

  it('still matches its own episode folder', () => {
    expect(folderMatchesShow('Dark.S01E01.GERMAN.1080p.WEB.h264-GRP', show('Dark'), [])).toBe(true);
  });

  it('does not let the numeric title "24" match every h264 release', () => {
    expect(folderMatchesShow('The.Rookie.S05E24.GERMAN.1080p.h264-GRP', show('24'), [])).toBe(false);
    expect(folderMatchesShow('24.S01E01.GERMAN.1080p.h264-GRP', show('24'), [])).toBe(true);
  });

  it('tolerates a production year or country tag between title and season marker', () => {
    expect(folderMatchesShow('Der.Pass.2018.S01E01.GERMAN.1080p', show('Der Pass'), [])).toBe(true);
    expect(folderMatchesShow('The.Office.US.S01E01.1080p', show('The Office'), [])).toBe(true);
  });

  it('matches via the recorded release name even when the title differs cosmetically', () => {
    const downloads = [{ release_name: 'Dark.Matter.S01.COMPLETE.GERMAN.1080p' }] as any;
    expect(folderMatchesShow('Dark.Matter.S01E03.GERMAN.1080p', show('Dark Matter'), downloads)).toBe(true);
  });

  it('rejects an unrelated folder that shares no title', () => {
    expect(folderMatchesShow('Breaking.Bad.S01E01.1080p', show('Better Call Saul'), [])).toBe(false);
  });
});

describe('nameStartsWithShowTitle — boundary rule for names without a season marker', () => {
  it('accepts an exact title and a title plus qualifier', () => {
    expect(nameStartsWithShowTitle('Dark', 'dark')).toBe(true);
    expect(nameStartsWithShowTitle('Dark (2017) - S01 - 1080p', 'dark')).toBe(true);
  });

  it('rejects a longer sibling title', () => {
    expect(nameStartsWithShowTitle('Dark Matter (2024) - S01 - 1080p', 'dark')).toBe(false);
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
