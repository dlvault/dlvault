import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSettings: Record<string, string> = {};
vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] ?? ''),
}));

const movies: any[] = [];
const updateMovieStatus = vi.hoisted(() => vi.fn());
const setRepairFlag = vi.hoisted(() => vi.fn());
vi.mock('../../src/database/services/movies', () => ({
  getMovieByTmdbId: vi.fn((tmdbId: number, type: string) =>
    movies.find(m => m.tmdb_id === tmdbId && m.media_type === type) || null),
  updateMovieStatus: (id: number, status: string) => {
    updateMovieStatus(id, status);
    const m = movies.find(x => x.id === id); if (m) m.status = status;
  },
  setRepairFlag,
}));

const seasons: any[] = [];
const updateSeasonStatus = vi.hoisted(() => vi.fn());
vi.mock('../../src/database/services/seasons', () => ({
  getSeasonsByShowId: vi.fn((id: number) => seasons.filter(s => s.movie_id === id)),
  updateSeasonStatus,
}));

const episodes: any[] = [];
const updateEpisodeStatus = vi.hoisted(() => vi.fn());
vi.mock('../../src/database/services/episodes', () => ({
  getEpisodesBySeasonId: vi.fn((id: number) => episodes.filter(e => e.season_id === id)),
  updateEpisodeStatus,
}));

const downloads: any[] = [];
vi.mock('../../src/database/services/downloads', () => ({
  getDownloadsByMovieId: vi.fn((id: number) => downloads.filter(d => d.movie_id === id)),
}));

const addBlocklistEntry = vi.hoisted(() => vi.fn((e: any) => ({ id: 1, ...e })));
vi.mock('../../src/database/services/blocklist', () => ({ addBlocklistEntry }));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: vi.fn() }));
const fsMock = vi.hoisted(() => ({
  dirs: {} as Record<string, { name: string; dir: boolean }[]>,
  renamed: [] as string[],
}));
vi.mock('fs', () => ({
  default: {
    existsSync: (p: string) => p in fsMock.dirs,
    readdirSync: (p: string) => (fsMock.dirs[p] || []).map(e => ({
      name: e.name, isDirectory: () => e.dir,
    })),
    renameSync: (from: string, to: string) => { fsMock.renamed.push(to); },
  },
}));
vi.mock('../../src/services/postprocess', () => ({
  normalizeTitle: (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ''),
  resolveLibraryTarget: () => '/movies',
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const issues = vi.hoisted(() => ({ value: [] as any[] | null }));
const commentOnIssue = vi.hoisted(() => vi.fn(async () => true));
const setIssueStatus = vi.hoisted(() => vi.fn(async () => true));
const createIssue = vi.hoisted(() => vi.fn(async () => true));
const requests = vi.hoisted(() => ({ value: [] as any[] | null }));
const meta = vi.hoisted(() => ({ value: { releaseDate: '2020-01-01' } as any }));
vi.mock('../../src/services/seerr', () => ({
  seerrService: {
    isConfigured: () => true,
    getIssues: async () => issues.value,
    getRequests: async () => requests.value,
    getMeta: async () => meta.value,
    commentOnIssue,
    setIssueStatus,
    createIssue,
  },
}));

import { processSeerrIssues, _resetIssueSweepState, restoreQuarantinedFiles, reportGiveUp } from '../../src/services/seerrIssues';

/** Shape captured from a live Seerr 3.4.1. */
const issue = (over: any = {}) => ({
  id: 1, issueType: 2, status: 1, problemSeason: 0, problemEpisode: 0,
  media: { id: 155, tmdbId: 550, mediaType: 'movie' },
  comments: [{ message: 'Ton ist Englisch statt Deutsch' }],
  createdBy: { displayName: 'Anna' },
  ...over,
});

const lastComment = () => String(commentOnIssue.mock.calls.at(-1)?.[1] ?? '');

describe('Seerr viewer reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    movies.length = 0; seasons.length = 0; episodes.length = 0; downloads.length = 0;
    mockSettings['seerr.issues_enabled'] = 'true';
    issues.value = [];
    fsMock.dirs = {};
    fsMock.renamed = [];
    _resetIssueSweepState();
    requests.value = [{ id: 1, media: { id: 155, tmdbId: 550 } }];
    movies.push({ id: 7, tmdb_id: 550, media_type: 'movie', title: 'Fight Club', status: 'downloaded', repair: 0 });
    downloads.push({ id: 1, movie_id: 7, season_number: null, release_name: 'Fight.Club.1999.GERMAN.1080p' });
  });

  describe('opt-in', () => {
    it('does nothing at all while switched off', async () => {
      mockSettings['seerr.issues_enabled'] = 'false';
      issues.value = [issue()];

      expect(await processSeerrIssues()).toBe(0);
      expect(commentOnIssue).not.toHaveBeenCalled();
      expect(addBlocklistEntry).not.toHaveBeenCalled();
    });
  });

  describe('acting on a report', () => {
    it('blocklists the file on disk before searching again', async () => {
      // Without this the pipeline would fetch the very same release back and the
      // report would achieve nothing.
      issues.value = [issue()];

      expect(await processSeerrIssues()).toBe(1);
      expect(addBlocklistEntry).toHaveBeenCalledWith(expect.objectContaining({
        release_name: 'Fight.Club.1999.GERMAN.1080p', movie_id: 7,
      }));
      expect(updateMovieStatus).toHaveBeenCalledWith(7, 'pending');
      expect(setRepairFlag).toHaveBeenCalledWith(7, true);
    });

    it('moves the reported file aside before the search restarts', async () => {
      // Without this the report achieves nothing: the title goes to pending and
      // dlvault's own library check finds the same bad file and flips it back to
      // downloaded. Seen in the field with 27 seconds between the two.
      fsMock.dirs['/movies'] = [{ name: 'Fight Club (1999)', dir: true }];
      fsMock.dirs['/movies/Fight Club (1999)'] = [{ name: 'Fight.Club.1999.mkv', dir: false }];
      issues.value = [issue()];

      await processSeerrIssues();

      expect(fsMock.renamed).toEqual(['/movies/Fight Club (1999)/Fight.Club.1999.mkv.incomplete']);
      expect(lastComment()).toContain('beiseitegelegt');
    });

    it('leaves another title\'s folder untouched', async () => {
      fsMock.dirs['/movies'] = [{ name: 'Fight Club (1999)', dir: true }, { name: 'Other Film (2020)', dir: true }];
      fsMock.dirs['/movies/Fight Club (1999)'] = [{ name: 'a.mkv', dir: false }];
      fsMock.dirs['/movies/Other Film (2020)'] = [{ name: 'b.mkv', dir: false }];
      issues.value = [issue()];

      await processSeerrIssues();
      expect(fsMock.renamed).toEqual(['/movies/Fight Club (1999)/a.mkv.incomplete']);
    });

    it('says plainly when there was no file to move', async () => {
      issues.value = [issue()];
      await processSeerrIssues();
      expect(lastComment()).toContain('keine Datei');
    });

    it('explains itself on the issue, naming what was blocked', async () => {
      issues.value = [issue()];
      await processSeerrIssues();

      expect(lastComment()).toContain('[dlvault]');
      expect(lastComment()).toContain('Ton');
      expect(lastComment()).toContain('Fight.Club.1999.GERMAN.1080p');
    });

    it('handles video and subtitle reports the same way', async () => {
      for (const type of [1, 3]) {
        vi.clearAllMocks();
        issues.value = [issue({ issueType: type })];
        expect(await processSeerrIssues(), String(type)).toBe(1);
        expect(addBlocklistEntry, String(type)).toHaveBeenCalled();
      }
    });

    it('refuses to guess at "other" and says so instead', async () => {
      // That category covers everything from a wrong title to a broken poster;
      // burning bandwidth on a guess helps nobody.
      issues.value = [issue({ issueType: 4 })];

      expect(await processSeerrIssues()).toBe(1);
      expect(addBlocklistEntry).not.toHaveBeenCalled();
      expect(updateMovieStatus).not.toHaveBeenCalled();
      expect(lastComment()).toContain('manuell');
    });

    it('says so when the title is not one dlvault manages', async () => {
      issues.value = [issue({ media: { id: 1, tmdbId: 99999, mediaType: 'movie' } })];

      await processSeerrIssues();
      expect(addBlocklistEntry).not.toHaveBeenCalled();
      expect(lastComment()).toContain('nicht');
    });

    it('waits rather than interrupting a download already running', async () => {
      movies[0].status = 'downloading';
      issues.value = [issue()];

      expect(await processSeerrIssues()).toBe(0);
      expect(addBlocklistEntry).not.toHaveBeenCalled();
      expect(lastComment()).toContain('bereits');
    });
  });

  describe('not repeating itself', () => {
    it('skips a report it has already answered', async () => {
      // dlvault's own comment IS the record that it acted — no extra bookkeeping.
      issues.value = [issue({
        comments: [{ message: 'Ton falsch' }, { message: '[dlvault] Gemeldet: Ton. dlvault sucht den Film neu.' }],
      })];

      expect(await processSeerrIssues()).toBe(0);
      expect(addBlocklistEntry).not.toHaveBeenCalled();
    });

    it('ignores issues that are already closed', async () => {
      issues.value = [issue({ status: 2 })];
      expect(await processSeerrIssues()).toBe(0);
    });
  });

  describe('season and episode scope', () => {
    beforeEach(() => {
      movies.length = 0; downloads.length = 0;
      movies.push({ id: 9, tmdb_id: 1399, media_type: 'show', title: 'Thrones', status: 'downloaded', repair: 0 });
      seasons.push({ id: 91, movie_id: 9, season_number: 1 }, { id: 92, movie_id: 9, season_number: 2 });
      episodes.push({ id: 911, season_id: 91, episode_number: 2 });
      downloads.push(
        { id: 1, movie_id: 9, season_number: 1, release_name: 'Thrones.S01.1080p' },
        { id: 2, movie_id: 9, season_number: 2, release_name: 'Thrones.S02.1080p' },
      );
    });

    const tvIssue = (over: any = {}) => issue({
      media: { id: 1, tmdbId: 1399, mediaType: 'tv' }, ...over,
    });

    it('touches only the season that was reported', async () => {
      // Reporting one bad season must not re-fetch the rest of the show.
      issues.value = [tvIssue({ problemSeason: 1 })];
      await processSeerrIssues();

      expect(addBlocklistEntry).toHaveBeenCalledTimes(1);
      expect(addBlocklistEntry).toHaveBeenCalledWith(expect.objectContaining({ release_name: 'Thrones.S01.1080p' }));
      expect(updateSeasonStatus).toHaveBeenCalledWith(91, 'pending');
    });

    it('quarantines only the reported season', async () => {
      // A bad season 1 must not take season 2 offline with it.
      fsMock.dirs['/movies'] = [{ name: 'Thrones (2011)', dir: true }];
      fsMock.dirs['/movies/Thrones (2011)'] = [
        { name: 'Thrones.S01E01.mkv', dir: false },
        { name: 'Thrones.S02E01.mkv', dir: false },
      ];
      issues.value = [tvIssue({ problemSeason: 1 })];

      await processSeerrIssues();
      expect(fsMock.renamed).toEqual(['/movies/Thrones (2011)/Thrones.S01E01.mkv.incomplete']);
    });

    it('narrows to a single episode when one is named', async () => {
      issues.value = [tvIssue({ problemSeason: 1, problemEpisode: 2 })];
      await processSeerrIssues();

      expect(updateEpisodeStatus).toHaveBeenCalledWith(911, 'pending');
      expect(lastComment()).toContain('S01E02');
    });

    it('falls back to the whole show when no season is named', async () => {
      issues.value = [tvIssue()];
      await processSeerrIssues();

      expect(addBlocklistEntry).toHaveBeenCalledTimes(2);
      expect(updateMovieStatus).toHaveBeenCalledWith(9, 'pending');
    });
  });

  describe('closing the loop', () => {
    const acted = issue({
      comments: [{ message: '[dlvault] Gemeldet: Ton. dlvault sucht den Film neu. Gesperrt: „x".' }],
    });

    it('closes the report once a replacement has landed', async () => {
      movies[0].status = 'downloaded';
      movies[0].repair = 0;
      issues.value = [acted];

      await processSeerrIssues();
      expect(setIssueStatus).toHaveBeenCalledWith(1, 'resolved');
    });

    it('stays open while the replacement is still being fetched', async () => {
      // `repair` clears exactly when a title next reaches 'downloaded', so both
      // conditions together mean the new file has actually arrived.
      movies[0].status = 'pending';
      movies[0].repair = 1;
      issues.value = [acted];

      await processSeerrIssues();
      expect(setIssueStatus).not.toHaveBeenCalled();
    });

    it('leaves a report it only commented on for a human', async () => {
      issues.value = [issue({
        comments: [{ message: '[dlvault] Gemeldet: Sonstiges. Dafür gibt es keine automatische Abhilfe — bitte manuell ansehen.' }],
      })];

      await processSeerrIssues();
      expect(setIssueStatus).not.toHaveBeenCalled();
    });
  });

  describe('overlapping runs', () => {
    it('lets only one sweep act on a report', async () => {
      // The webhook fires immediately and the two-minute sweep runs anyway, so
      // the two overlap. "Already handled" is read from a comment written only
      // AFTER the work, so without a guard both passes see the same report as
      // fresh: blocklisting twice, resetting twice, commenting twice.
      let release: () => void = () => {};
      const gate = new Promise<void>(r => { release = r; });
      commentOnIssue.mockImplementationOnce(async () => { await gate; return true; });
      issues.value = [issue()];

      const first = processSeerrIssues();
      const second = await processSeerrIssues();   // overlaps the first
      release();
      await first;

      expect(second).toBe(0);
      expect(addBlocklistEntry).toHaveBeenCalledTimes(1);
    });

    it('runs again once the previous sweep finished', async () => {
      issues.value = [issue()];
      await processSeerrIssues();

      vi.clearAllMocks();
      issues.value = [issue({ id: 2 })];
      expect(await processSeerrIssues()).toBe(1);
    });

    it('releases the guard even when the sweep throws', async () => {
      issues.value = [issue()];
      commentOnIssue.mockRejectedValueOnce(new Error('boom'));
      await processSeerrIssues();

      issues.value = [issue({ id: 3 })];
      expect(await processSeerrIssues()).toBe(1);
    });
  });

  describe('resilience', () => {
    it('carries on when one report cannot be processed', async () => {
      commentOnIssue.mockRejectedValueOnce(new Error('boom'));
      issues.value = [issue({ id: 1 }), issue({ id: 2 })];

      expect(await processSeerrIssues()).toBe(1);
    });

    it('does nothing when Seerr cannot be reached', async () => {
      issues.value = null;
      expect(await processSeerrIssues()).toBe(0);
      expect(commentOnIssue).not.toHaveBeenCalled();
    });
  });
});


/**
 * When dlvault stops trying, both the file and the requester need closing out.
 * Until now the news went to Telegram only, so whoever asked through Seerr saw
 * "Angefragt" indefinitely and waited for something nobody was attempting.
 */
describe('abandoning a repair', () => {
  const movie = { id: 7, tmdb_id: 550, media_type: 'movie', title: 'Fight Club', year: 1999 } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    mockSettings['seerr.issues_enabled'] = 'true';
    fsMock.dirs = {};
    fsMock.renamed = [];
    requests.value = [{ id: 1, type: 'movie', media: { id: 155, tmdbId: 550 } }];
    meta.value = { releaseDate: '2020-01-01' };
  });

  it('puts the old copy back', async () => {
    // dlvault took it away expecting a replacement; leaving the viewer with
    // nothing would be worse than the flaw they reported.
    fsMock.dirs['/movies'] = [{ name: 'Fight Club (1999)', dir: true }];
    fsMock.dirs['/movies/Fight Club (1999)'] = [{ name: 'a.mkv.incomplete', dir: false }];

    expect(restoreQuarantinedFiles(movie)).toBe(1);
    expect(fsMock.renamed).toEqual(['/movies/Fight Club (1999)/a.mkv']);
  });

  it('leaves healthy files untouched', async () => {
    fsMock.dirs['/movies'] = [{ name: 'Fight Club (1999)', dir: true }];
    fsMock.dirs['/movies/Fight Club (1999)'] = [{ name: 'a.mkv', dir: false }];

    expect(restoreQuarantinedFiles(movie)).toBe(0);
    expect(fsMock.renamed).toEqual([]);
  });

  it('stays quiet about a film that has not come out yet', async () => {
    // Ten fruitless searches for an unreleased title measure nothing but
    // patience, and people park upcoming films in the queue on purpose.
    meta.value = { releaseDate: '2099-12-01' };

    expect(await reportGiveUp(movie, 0)).toBe(false);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('says it is still looking, not that it gave up', async () => {
    // Since the retry ceiling became a 48h standing watch, giving up is no
    // longer what happens — the wording has to match.
    await reportGiveUp(movie, 0);

    const text = createIssue.mock.calls[0][2];
    expect(text).not.toContain('aufgegeben');
    expect(text).toContain('sucht im eingestellten Intervall weiter');
  });

  it('opens an issue rather than declining the request', async () => {
    // Declining works and answers 200, but it is wrong twice: nobody declined
    // anything, and a declined request is what dropDeclined() deletes titles
    // for — dlvault would erase its own entry.
    expect(await reportGiveUp(movie, 2)).toBe(true);

    expect(createIssue).toHaveBeenCalledWith(155, 4, expect.stringContaining('kein passendes Release'));
    expect(createIssue.mock.calls[0][2]).toContain('wiederhergestellt');
  });

  it('stays silent when nobody asked for it through Seerr', async () => {
    requests.value = [{ id: 1, type: 'movie', media: { id: 999, tmdbId: 12345 } }];
    expect(await reportGiveUp(movie, 0)).toBe(false);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('stays silent while the feature is switched off', async () => {
    mockSettings['seerr.issues_enabled'] = 'false';
    expect(await reportGiveUp(movie, 0)).toBe(false);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('survives Seerr being unreachable', async () => {
    requests.value = null;
    expect(await reportGiveUp(movie, 0)).toBe(false);
  });
});
