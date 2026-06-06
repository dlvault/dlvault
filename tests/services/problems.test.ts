import { describe, it, expect, vi, beforeEach } from 'vitest';

const st = vi.hoisted(() => ({
  movies: [] as any[],
  activity: {} as Record<string, { movie_id: number; at: string; details: string | null }[]>,
  resolve: [] as any[],
  room: { ok: true } as any,
  gaps: {} as Record<number, { season_number: number }[]>,
  mass: undefined as { at: string | null; details: string | null } | undefined,
  imports: [] as { movie_id: number; at: string }[],
  info: {} as Record<number, any>,
  latest: null as number | null,
  ready: true,
  repeats: [] as { movie_id: number; details: string | null; n: number; at: string }[],
}));
vi.mock('../../src/database/index', () => ({
  default: {
    prepare: (q: string) => ({
      all: (arg: any) => (q.includes('FROM seasons') ? st.gaps[arg] ?? []
        : q.includes("action = 'moved_to_library'") ? st.imports
        : q.includes("action = 'sent_to_jdownloader'") ? st.repeats
        : st.activity[arg] ?? []),
      get: () => (q.includes('MAX(season_number)') ? { n: st.latest } : st.mass),
    }),
  },
  getSetting: () => '',
}));
vi.mock('../../src/database/services/movies', () => ({ getAllMovies: () => st.movies }));
vi.mock('../../src/services/scheduler', () => ({ getResolveStats: () => st.resolve }));
vi.mock('../../src/services/diskGuard', () => ({ checkRoom: () => st.room }));
vi.mock('../../src/services/releaseHold', () => ({ cachedReleaseInfo: (id: number) => st.info[id], releaseInfoReady: () => st.ready }));
vi.mock('../../src/services/watchdog', () => ({ getWatchdogFindings: () => [] }));

import { collectProblems, isExpectedWait } from '../../src/services/problems';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const sql = (iso: string) => iso.replace('T', ' ').slice(0, 19);

describe('collectProblems', () => {
  beforeEach(() => { st.movies = []; st.activity = {}; st.resolve = []; st.room = { ok: true }; st.gaps = {}; st.mass = undefined; st.imports = []; st.info = {}; st.repeats = []; st.ready = true; });

  it('lists a title not found for over a month, but not one waiting for its release date', () => {
    st.movies = [
      { id: 1, title: 'Grell', year: 2024, status: 'not_found', added_at: sql('2026-08-01T00:00:00Z'), not_found_reason: 'not_available' },
      { id: 2, title: 'Sandmere', year: 2027, status: 'not_found', added_at: sql('2026-06-01T00:00:00Z'), release_hold_until: '2027-02-01' },
      { id: 3, title: 'Wardline', year: 2026, status: 'not_found', added_at: sql('2026-10-10T00:00:00Z') },
    ];
    const p = collectProblems(NOW);
    expect(p.map(x => x.movieId)).toEqual([1]);
    expect(p[0].detail).toContain('kein Release bei der Quelle');
    expect(p[0].actions).toContain('retry');
  });

  it('surfaces an aired season without a release on a show that counts as complete', () => {
    st.movies = [
      { id: 8, title: 'Grell', year: 2023, media_type: 'show', status: 'downloaded', last_checked_at: sql('2026-10-14T01:00:00Z') },
      { id: 9, title: 'Sandmere', year: 2020, media_type: 'show', status: 'downloaded' },
    ];
    st.gaps = { 8: [{ season_number: 3 }] };
    const p = collectProblems(NOW);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ movieId: 8, kind: 'Staffel ohne Release', severity: 'info' });
    expect(p[0].detail).toContain('S03');
  });

  it('lists no long-missing title or season gap before the release dates are looked up after a start', () => {
    st.movies = [
      { id: 1, title: 'Grell', year: 2024, status: 'not_found', added_at: sql('2026-08-01T00:00:00Z'), not_found_reason: 'not_available' },
      { id: 8, title: 'Sandmere', year: 2023, media_type: 'show', status: 'downloaded' },
    ];
    st.gaps = { 8: [{ season_number: 3 }] };
    st.ready = false;
    expect(collectProblems(NOW)).toEqual([]);
    st.info = { 1: null };                 // looked up: TMDb knows nothing — that one is a finding again
    expect(collectProblems(NOW).map(p => p.movieId)).toEqual([1]);
    st.ready = true;
    expect(collectProblems(NOW).map(p => p.movieId).sort()).toEqual([1, 8]);
  });

  it('flags a release that keeps being sent to JDownloader', () => {
    st.movies = [{ id: 21, title: 'Grell', year: 2026, media_type: 'show', status: 'downloading' }];
    st.repeats = [{ movie_id: 21, details: 'Grell S01 [PACK]: sent 19 link(s) to JDownloader', n: 12, at: '2026-10-14 10:00:00' }];
    const p = collectProblems(NOW);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ movieId: 21, kind: 'Wird immer wieder geladen', severity: 'warning' });
    expect(p[0].detail).toBe('Grell S01 [PACK] in 7 Tagen 12× an JDownloader geschickt — läuft vermutlich im Kreis');
  });

  it('lists a missing film with re-download / deleted buttons, but not once it is marked removed', () => {
    st.movies = [
      { id: 11, title: 'Grell', year: 2024, status: 'downloaded', removed_at: null },
      { id: 12, title: 'Sandmere', year: 2023, status: 'downloaded', removed_at: '2026-10-14 10:00:00' },
    ];
    st.activity.library_missing = [
      { movie_id: 11, at: '2026-10-14 09:00:00', details: 'Datei fehlt' },
      { movie_id: 12, at: '2026-10-14 09:00:00', details: 'Datei fehlt' },
    ];
    const p = collectProblems(NOW);
    expect(p.map(x => x.movieId)).toEqual([11]);
    expect(p[0].actions).toEqual(['redownload', 'mark_removed']);
  });

  it('calls a cut film a file, not an episode', () => {
    st.movies = [{ id: 31, title: 'Grell', year: 2017, status: 'pending', repair: 1 },
                 { id: 32, title: 'Sandmere', year: 2023, status: 'pending', media_type: 'show', repair: 1 }];
    st.activity.integrity_incomplete = [
      { movie_id: 31, at: '2026-10-13 09:00:00', details: 'Datei bricht nach 46 von 97 Minuten ab' },
      { movie_id: 32, at: '2026-10-13 09:00:00', details: 'S01E09: Datei bricht ab' },
    ];
    const kinds = Object.fromEntries(collectProblems(NOW).map(p => [p.movieId, p.kind]));
    expect(kinds[31]).toBe('Datei unvollständig — wird neu geladen');
    expect(kinds[32]).toBe('Folge unvollständig — wird nachgeladen');
  });

  it('drops an entry once the title was imported again afterwards', () => {
    st.movies = [{ id: 21, title: 'Grell', year: 2023, status: 'downloaded' }, { id: 22, title: 'Sandmere', year: 2024, status: 'downloaded' }];
    st.activity.audio_language_mismatch = [
      { movie_id: 21, at: '2026-10-13 09:00:00', details: 'ohne german-Tonspur' },
      { movie_id: 22, at: '2026-10-13 09:00:00', details: 'ohne german-Tonspur' },
    ];
    st.imports = [{ movie_id: 21, at: '2026-10-14 08:00:00' }, { movie_id: 22, at: '2026-10-12 08:00:00' }];
    expect(collectProblems(NOW).map(p => p.movieId)).toEqual([22]);   // 21 got its German copy since
  });

  it('counts a long wait for a release as information, not a warning', () => {
    st.movies = [{ id: 23, title: 'Wardline', year: 2026, status: 'not_found', added_at: sql('2026-06-01T00:00:00Z') }];
    expect(collectProblems(NOW)[0].severity).toBe('info');
  });

  it('raises one system error when many films vanish at once', () => {
    st.mass = { at: '2026-10-14 11:00:00', details: '12 Filme fehlen gleichzeitig' };
    const p = collectProblems(NOW);
    expect(p[0]).toMatchObject({ key: 'library_mass_missing', severity: 'error', movieId: null });
  });

  it('flags a download that has not moved for days as an error', () => {
    st.movies = [{ id: 4, title: 'Lanternfall', year: 2025, status: 'downloading', updated_at: sql('2026-10-08T00:00:00Z') }];
    expect(collectProblems(NOW)[0]).toMatchObject({ severity: 'error', kind: 'Download hängt' });
  });

  it('shows a recent failed move only while the title is still waiting for it', () => {
    st.movies = [
      { id: 5, title: 'A', status: 'downloading' },
      { id: 6, title: 'B', status: 'downloaded' },
    ];
    st.activity.move_failed = [
      { movie_id: 5, at: '2026-10-14 10:00:00', details: 'Move to library failed: ENOSPC' },
      { movie_id: 6, at: '2026-10-14 09:00:00', details: 'old' },
    ];
    const p = collectProblems(NOW);
    expect(p.map(x => x.movieId)).toEqual([5]);
    expect(p[0].detail).toContain('ENOSPC');
  });

  it('adds system-wide findings and sorts errors first', () => {
    st.movies = [{ id: 7, title: 'C', status: 'not_found', added_at: sql('2026-01-01T00:00:00Z') }];
    st.resolve = [{ plugin: 'src-a', attempts: 10, ok: 1 }];
    st.room = { ok: false, detail: 'Filme: 5.0 GB frei, 20.0 GB nötig' };
    const p = collectProblems(NOW);
    expect(p.map(x => x.severity)).toEqual(['error', 'error', 'info']);
    expect(p.map(x => x.key)).toEqual(expect.arrayContaining(['resolve:src-a', 'disk']));
  });
});

describe('the normal wait for a German release is not a problem', () => {
  beforeEach(() => { st.movies = []; st.activity = {}; st.resolve = []; st.room = { ok: true }; st.gaps = {}; st.mass = undefined; st.imports = []; st.info = {}; });
  const NOW2 = Date.parse('2026-10-15T12:00:00Z');
  it('isExpectedWait: cinema this summer, digital recently, a fresh series — yes; long gone — no', () => {
    expect(isExpectedWait({ kind: 'movie', status: 'Released', theatrical: '2026-07-16', digital: null }, NOW2)).toBe(true);
    expect(isExpectedWait({ kind: 'movie', status: 'Released', theatrical: '2018-04-18', digital: null }, NOW2)).toBe(false);
    expect(isExpectedWait({ kind: 'movie', status: 'Released', theatrical: '2026-06-01', digital: '2026-10-01' }, NOW2)).toBe(true);
    expect(isExpectedWait({ kind: 'movie', status: 'Released', theatrical: '2026-01-01', digital: '2026-03-01' }, NOW2)).toBe(false);
    // A running show alone is no excuse — its OLD gaps must stay visible.
    expect(isExpectedWait({ kind: 'show', status: 'Returning Series', firstAir: '2023-01-05', nextAir: '2026-12-30' }, NOW2)).toBe(false);
    expect(isExpectedWait({ kind: 'show', status: 'Ended', firstAir: '2026-06-18', nextAir: null }, NOW2)).toBe(true);
    expect(isExpectedWait(null, NOW2)).toBe(false);
  });

  it('keeps such titles, and repairs that already have a copy, off the list', () => {
    const old = '2026-06-01 00:00:00';
    st.movies = [
      { id: 1, title: 'Grell', year: 2026, status: 'not_found', added_at: old, not_found_reason: 'not_available' },
      { id: 2, title: 'Sandmere', year: 2016, status: 'not_found', added_at: old, not_found_reason: 'quality_mismatch', repair: 1 },
      { id: 3, title: 'Wardline', year: 2018, status: 'not_found', added_at: old, not_found_reason: 'not_available' },
      { id: 4, title: 'Lanternfall', year: 2027, status: 'not_found', added_at: old, not_found_reason: 'not_available' },
    ];
    st.info = { 1: { kind: 'movie', status: 'Released', theatrical: '2026-07-16', digital: null },
                3: { kind: 'movie', status: 'Released', theatrical: '2018-04-18', digital: null } };
    expect(collectProblems(NOW2).map(p => p.movieId)).toEqual([3]);
  });

  it('suggests "no German version" only for titles known to be out', () => {
    const old = '2026-06-01 00:00:00';
    st.movies = [
      { id: 1, title: 'Grell', year: 2026, status: 'not_found', added_at: old, not_found_reason: 'not_available' },
      { id: 2, title: 'Sandmere', year: null, status: 'not_found', added_at: old, not_found_reason: 'not_available' },
      { id: 3, title: 'Wardline', year: 2018, status: 'not_found', added_at: old, not_found_reason: 'not_available' },
    ];
    st.info = {};
    const d = Object.fromEntries(collectProblems(NOW2).map(p => [p.movieId, p.detail]));
    expect(d[1]).toContain('vielleicht noch nicht erschienen');
    expect(d[2]).toContain('vielleicht noch nicht erschienen');
    expect(d[3]).toContain('keine deutsche Fassung');
  });
});

describe('season gaps of a running show', () => {
  beforeEach(() => { st.movies = []; st.activity = {}; st.resolve = []; st.room = { ok: true }; st.gaps = {}; st.mass = undefined; st.imports = []; st.info = {}; });
  it('hides the gap only when it is the latest, still airing season', () => {
    st.movies = [{ id: 8, title: 'Grell', year: 2023, media_type: 'show', status: 'downloaded' }];
    st.info = { 8: { kind: 'show', status: 'Returning Series', firstAir: '2023-01-05', nextAir: '2026-12-30' } };
    st.latest = 3;
    st.gaps = { 8: [{ season_number: 3 }] };
    expect(collectProblems(Date.parse('2026-10-15T12:00:00Z'))).toHaveLength(0);
    st.gaps = { 8: [{ season_number: 1 }] };                  // an old season with no German release
    expect(collectProblems(Date.parse('2026-10-15T12:00:00Z'))).toHaveLength(1);
  });
});
