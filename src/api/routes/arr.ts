import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { getSetting, setSetting } from '../../database/index';
import {
  addMovie, getMovieByTmdbId, getMovieByImdbId, getMovieByTvdbId, setMovieTvdbId,
  setSeasonsExplicit, getAllMovies, type Movie,
} from '../../database/services/movies';
import { getSeasonsByShowId, addSeason } from '../../database/services/seasons';
import { getAllDownloads } from '../../database/services/downloads';
import { addLogEntry } from '../../database/services/activityLog';
import { jdownloaderService } from '../../jdownloader/index';
import { logger } from '../../utils/logger';

/**
 * A Radarr/Sonarr-shaped face for dlvault, so Seerr can drive it as a
 * fulfilment service instead of dlvault having to poll for approved requests.
 *
 * Every endpoint and payload here was captured from a live Jellyseerr 2.7.3
 * talking to a stand-in server — not reconstructed from documentation. Two
 * details that guesswork would have got wrong:
 *
 *   - authentication travels as `?apikey=` in the query string, not a header
 *   - the path is `qualityProfile` (camelCase), not `qualityprofile`
 *
 * The exchange Seerr actually performs:
 *
 *   connect  GET  system/status → qualityProfile → rootfolder → tag
 *   add mov  GET  qualityProfile, GET movie/lookup?term=tmdb:<id>, POST movie
 *   add tv   GET  series/lookup?term=tvdb:<id>, POST series
 *
 * Radarr is addressed by `tmdbId`, Sonarr by `tvdbId` — they are not
 * interchangeable, and a show request arrives carrying only the latter.
 *
 * Mounted outside `/api/` so dlvault's own browser-session auth never sees it;
 * this surface authenticates on its own terms.
 */

/** Which flavour a request came in on, derived from the mount path. */
type Flavour = 'radarr' | 'sonarr';

/**
 * Quality profiles offered to Seerr, mapped onto dlvault's own tiers.
 *
 * The id is the tier's rank, which keeps the mapping stable if the list is ever
 * reordered — Seerr stores the id, not the name.
 */
const QUALITY_PROFILES = [
  { id: 4, name: '2160p (4K)', quality: '2160p' },
  { id: 3, name: '1080p', quality: '1080p' },
  { id: 2, name: '720p', quality: '720p' },
  { id: 1, name: '480p', quality: '480p' },
];

function qualityForProfileId(id: number | undefined): string | null {
  return QUALITY_PROFILES.find(p => p.id === id)?.quality ?? null;
}

/**
 * Root folders exposed to Seerr — dlvault's libraries.
 *
 * The kids libraries appear only when configured, which is what makes
 * Seerr's override rules useful: a rule on the Animation genre can route a
 * request straight into the kids library.
 */
function rootFolders(flavour: Flavour): { id: number; path: string; kids: boolean }[] {
  const out: { id: number; path: string; kids: boolean }[] = [];
  const main = getSetting(flavour === 'sonarr' ? 'paths.series' : 'paths.movies');
  const kids = getSetting(flavour === 'sonarr' ? 'paths.kids_series' : 'paths.kids_movies');
  if (main) out.push({ id: 1, path: main, kids: false });
  if (kids) out.push({ id: 2, path: kids, kids: true });
  return out;
}

/** Generates the shared key on first use so setup never blocks on it. */
export function getArrApiKey(): string {
  let key = getSetting('arr.api_key');
  if (!key) {
    key = crypto.randomBytes(16).toString('hex');
    setSetting('arr.api_key', key);
    logger.info('Generated API key for the Radarr/Sonarr-compatible endpoint');
  }
  return key;
}

/**
 * Accepts the key from either transport. Seerr uses the query string, but
 * other Radarr clients (and manual testing) use the header, and honouring both
 * costs nothing.
 */
function auth(req: Request, res: Response, next: NextFunction): void {
  if (getSetting('arr.enabled') !== 'true') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const provided = String(req.query.apikey || req.headers['x-api-key'] || '');
  const expected = getArrApiKey();
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/** Radarr and Sonarr report different names; Seerr shows them verbatim. */
function systemStatus(flavour: Flavour) {
  const appName = flavour === 'sonarr' ? 'Sonarr' : 'Radarr';
  return {
    appName,
    instanceName: `dlvault (${appName})`,
    version: flavour === 'sonarr' ? '4.0.10.2544' : '5.14.0.9383',
    buildTime: '2026-01-01T00:00:00Z',
    isProduction: true,
    isDebug: false,
    startupPath: '/app',
    appData: '/app/data',
    osName: 'linux',
    runtimeName: 'node',
    packageVersion: process.env.npm_package_version || '0.5.1',
  };
}

/** dlvault status → the two flags Radarr exposes per item. */
function movieFlags(m: Movie) {
  return {
    monitored: !['downloaded'].includes(m.status),
    hasFile: m.status === 'downloaded',
    isAvailable: m.status === 'downloaded',
  };
}

function buildRouter(flavour: Flavour): Router {
  const router = Router();
  router.use(auth);

  router.get('/system/status', (_req, res) => res.json(systemStatus(flavour)));
  router.get('/health', (_req, res) => res.json([]));

  /**
   * Radarr's command queue.
   *
   * Seerr's download tracker asks for this *before* the queue, and a 404 here
   * made it abandon the whole poll — its log said only "Unable to get queue
   * from Radarr server", while /queue itself answered 200 to an identical
   * manual request. dlvault runs no commands, so an empty list is the truth.
   */
  router.get('/command', (_req, res) => res.json([]));

  /**
   * Accepts a command without running one. Callers use this to ask for a
   * refresh or a search; dlvault schedules that work itself, so the honest
   * answer is "queued" followed by nothing happening — which is also what
   * Radarr reports for a command that finds nothing to do.
   */
  router.post('/command', (req, res) => {
    const name = String(req.body?.name || 'unknown');
    logger.debug(`arr endpoint: ignoring command "${name}" — dlvault schedules its own work`);
    res.status(201).json({
      id: 1, name, commandName: name, status: 'completed', result: 'successful',
      queued: new Date().toISOString(), trigger: 'manual',
    });
  });
  router.get('/tag', (_req, res) => res.json([]));
  router.get('/languageprofile', (_req, res) => res.json([{ id: 1, name: 'Any' }]));
  router.get('/language', (_req, res) => res.json([{ id: 1, name: 'Any' }]));

  router.get('/qualityProfile', (_req, res) =>
    res.json(QUALITY_PROFILES.map(p => ({
      id: p.id,
      name: p.name,
      upgradeAllowed: true,
      cutoff: p.id,
      items: [],
    }))));
  // Radarr v3 also answers the all-lowercase spelling; mirror it so other
  // clients do not fall over on a 404.
  router.get('/qualityprofile', (_req, res) =>
    res.json(QUALITY_PROFILES.map(p => ({ id: p.id, name: p.name, upgradeAllowed: true, cutoff: p.id, items: [] }))));

  router.get('/rootfolder', (_req, res) =>
    res.json(rootFolders(flavour).map(f => ({
      id: f.id,
      path: f.path,
      accessible: true,
      // Seerr only displays this; dlvault does not track free space, and
      // reporting a fake number would be worse than reporting none.
      freeSpace: null,
      unmappedFolders: [],
    }))));

  /**
   * Lookup before add.
   *
   * Seerr ignores nearly everything returned here — the observed POST
   * carried Seerr's own title, year and slug, not the ones the stand-in
   * server had supplied. What matters is that the array is non-empty and the
   * id matches, so the stub below is faithful rather than lazy.
   */
  const lookup = (req: Request, res: Response) => {
    const term = String(req.query.term || '');
    const m = term.match(/^(tmdb|tvdb|imdb):(.+)$/i);
    if (!m) {
      res.json([]);
      return;
    }
    const [, kind, rawId] = m;
    const id = Number(rawId);
    const base = {
      title: '', year: 0, titleSlug: String(rawId), images: [], monitored: false,
      hasFile: false, added: '0001-01-01T00:00:00Z', overview: '',
    };
    if (kind.toLowerCase() === 'tvdb') {
      res.json([{ ...base, tvdbId: id, seasons: [], status: 'continuing' }]);
      return;
    }
    if (kind.toLowerCase() === 'imdb') {
      res.json([{ ...base, imdbId: rawId }]);
      return;
    }
    res.json([{ ...base, tmdbId: id }]);
  };
  router.get('/movie/lookup', lookup);
  router.get('/series/lookup', lookup);

  /** Everything dlvault tracks of this flavour — Seerr syncs status from it. */
  router.get('/movie', (_req, res) => {
    const wanted = flavour === 'sonarr' ? 'show' : 'movie';
    res.json(getAllMovies().filter(m => m.media_type === wanted).map(m => ({
      id: m.id,
      title: m.title,
      year: m.year,
      tmdbId: m.tmdb_id ?? 0,
      imdbId: m.imdb_id || undefined,
      titleSlug: m.slug,
      rootFolderPath: rootFolders(flavour)[0]?.path || '',
      qualityProfileId: QUALITY_PROFILES.find(p => p.quality === m.desired_quality)?.id ?? 3,
      images: [],
      ...movieFlags(m),
    })));
  });
  router.get('/series', (_req, res) => res.json(
    getAllMovies().filter(m => m.media_type === 'show').map(m => ({
      id: m.id,
      title: m.title,
      year: m.year,
      tvdbId: m.tvdb_id ?? 0,
      tmdbId: m.tmdb_id ?? 0,
      imdbId: m.imdb_id || undefined,
      titleSlug: m.slug,
      rootFolderPath: rootFolders(flavour)[0]?.path || '',
      qualityProfileId: QUALITY_PROFILES.find(p => p.quality === m.desired_quality)?.id ?? 3,
      images: [],
      seasons: getSeasonsByShowId(m.id).map(s => ({
        seasonNumber: s.season_number,
        monitored: s.status !== 'downloaded',
        statistics: {
          episodeFileCount: s.status === 'downloaded' ? (s.episode_count ?? 0) : 0,
          episodeCount: s.episode_count ?? 0,
          totalEpisodeCount: s.episode_count ?? 0,
          percentOfEpisodes: s.status === 'downloaded' ? 100 : 0,
        },
      })),
      ...movieFlags(m),
    })),
  ));

  /**
   * Active downloads, which is what fills Seerr's progress display.
   *
   * dlvault does not track per-download byte counts here, so `sizeleft` mirrors
   * `size` — an honest "in progress, amount unknown" rather than a made-up
   * percentage.
   */
  router.get('/queue', async (_req, res) => {
    const wanted = flavour === 'sonarr' ? 'show' : 'movie';
    // Keyed off the title's own status rather than the download rows: a title is
    // "in the queue" from the moment dlvault starts working on it, which is
    // earlier (and truer) than the first row reaching JDownloader.
    const active = getAllMovies().filter(m =>
      m.media_type === wanted && ['searching', 'found', 'downloading'].includes(m.status));
    const releaseFor = new Map<number, string>();
    for (const d of getAllDownloads()) {
      if (!releaseFor.has(d.movie_id) && d.release_name) releaseFor.set(d.movie_id, d.release_name);
    }
    // Real byte counts come from JDownloader, matched through the package id the
    // download rows already carry. Reporting zeroes here was not merely
    // uninformative: Seerr computes progress as (size - sizeleft) / size, so a
    // zero size yields nothing to display and the download bar stayed empty.
    const bytesFor = new Map<number, { loaded: number; total: number; eta: number | null }>();
    try {
      const packages = await jdownloaderService.getDownloadPackages();
      if (packages) {
        for (const m of active) {
          // Matched by package-name prefix, the same way the sync loop does it
          // (scheduler.ts). The downloads table has a jdownloader_package_id
          // column, but nothing ever writes to it — every row is NULL — so it
          // cannot be used for this.
          const prefix = `${m.title.replace(/:/g, ';')}${m.year ? ` (${m.year})` : ''}`;
          const mine = packages.filter(p => typeof p.name === 'string' && p.name.startsWith(prefix));
          if (mine.length === 0) continue;
          const acc = { loaded: 0, total: 0, eta: null as number | null };
          for (const pkg of mine) {
            acc.loaded += Number(pkg.bytesLoaded) || 0;
            acc.total += Number(pkg.bytesTotal) || 0;
            // Slowest part decides when the title as a whole is done.
            const eta = Number(pkg.eta);
            if (Number.isFinite(eta) && eta > 0) acc.eta = Math.max(acc.eta ?? 0, eta);
          }
          bytesFor.set(m.id, acc);
        }
      }
    } catch (error: any) {
      // JD being unreachable must not break the queue listing — the titles are
      // still queued, we just cannot say how far along they are.
      logger.debug(`arr queue: no byte counts from JDownloader: ${error?.message || error}`);
    }

    const records = active.map(m => {
      const b = bytesFor.get(m.id);
      const size = b?.total ?? 0;
      const sizeleft = b ? Math.max(0, b.total - b.loaded) : 0;
      const secs = b?.eta ?? null;
      return {
        id: m.id,
        title: releaseFor.get(m.id) || m.title,
        status: m.status === 'downloading' ? 'downloading' : 'queued',
        trackedDownloadStatus: 'ok',
        trackedDownloadState: m.status === 'downloading' ? 'downloading' : 'importPending',
        size,
        sizeleft,
        timeleft: secs != null ? new Date(secs * 1000).toISOString().slice(11, 19) : null,
        // Omitted rather than null when unknown: Seerr turns a null into the
        // epoch, and a title queued behind another then claims to have finished
        // in 1970.
        ...(secs != null ? { estimatedCompletionTime: new Date(Date.now() + secs * 1000).toISOString() } : {}),
        // Fields a real Radarr always sends. Leaving them out made Seerr's client
        // discard the WHOLE response — its log said only "Unable to get queue",
        // with the endpoint answering 200 to an identical manual request. A
        // stand-in server carrying these exact fields was accepted immediately,
        // which is how the difference was found.
        languages: [],
        quality: {},
        customFormats: [],
        statusMessages: [],
        errorMessage: null,
        downloadId: `dlvault-${m.id}`,
        // Radarr only knows 'usenet' and 'torrent'. Direct downloads are neither,
        // and 'usenet' is the closer lie: a single-source fetch, not a swarm.
        protocol: 'usenet',
        downloadClient: 'JDownloader',
        indexer: 'dlvault',
        outputPath: getSetting('paths.downloads') || '/downloads',
        ...(wanted === 'movie' ? { movieId: m.id } : { seriesId: m.id }),
      };
    });
    res.json({
      page: 1,
      pageSize: records.length || 10,
      sortKey: 'timeleft',
      sortDirection: 'ascending',
      totalRecords: records.length,
      records,
    });
  });

  /** Seerr hands a movie over. */
  router.post('/movie', (req, res) => {
    const b = req.body || {};
    const tmdbId = Number(b.tmdbId);
    if (!tmdbId) {
      res.status(400).json({ error: 'tmdbId required' });
      return;
    }
    const existing = getMovieByTmdbId(tmdbId, 'movie');
    if (existing) {
      // Real Radarr answers 400 here, and mirroring that was a mistake: Seerr
      // logs "you can safely ignore this error" and then marks the request
      // FAILED anyway, so a title dlvault is already handling showed up red.
      // Reporting the existing entry is both friendlier and more truthful.
      logger.info(`Radarr endpoint: ${existing.title} already tracked — reporting it as accepted`);
      res.status(201).json({
        id: existing.id, title: existing.title, year: existing.year,
        tmdbId, monitored: existing.status !== 'downloaded', hasFile: existing.status === 'downloaded',
      });
      return;
    }
    const quality = qualityForProfileId(Number(b.qualityProfileId)) || getSetting('quality.minimum') || '1080p';
    const title = String(b.title || `TMDb ${tmdbId}`);
    const added = addMovie({
      trakt_id: 0,
      imdb_id: String(b.imdbId || ''),
      tmdb_id: tmdbId,
      title,
      year: Number(b.year) || 0,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      media_type: 'movie',
      status: 'pending',
      desired_quality: quality,
      watchlist_source: 'seerr',
    });
    addLogEntry(null, 'movie_added', `New movie from Seerr: ${title} (${added.year})`);
    logger.info(`Radarr endpoint: queued ${title} (${added.year}) at ${quality}`);
    res.status(201).json({ id: added.id, title, year: added.year, tmdbId, monitored: true, hasFile: false });
  });

  /**
   * Seerr hands a show over.
   *
   * Only the seasons flagged `monitored` are created — that flag is how a
   * request for seasons 1 and 2 stays a request for seasons 1 and 2 instead of
   * pulling in the whole run.
   */
  router.post('/series', (req, res) => {
    const b = req.body || {};
    const tvdbId = Number(b.tvdbId) || 0;
    const tmdbId = Number(b.tmdbId) || 0;
    if (!tvdbId && !tmdbId) {
      res.status(400).json({ error: 'tvdbId or tmdbId required' });
      return;
    }
    const title = String(b.title || `TVDb ${tvdbId}`);
    const quality = qualityForProfileId(Number(b.qualityProfileId)) || getSetting('quality.minimum') || '1080p';

    // tvdbId first: the captured Sonarr payload carries nothing else, so any
    // other order finds nothing and duplicates the show on every repeat request.
    let show = tvdbId ? getMovieByTvdbId(tvdbId) : undefined;
    if (!show && tmdbId) show = getMovieByTmdbId(tmdbId, 'show');
    if (!show && b.imdbId) show = getMovieByImdbId(String(b.imdbId));
    if (show && tvdbId && !show.tvdb_id) setMovieTvdbId(show.id, tvdbId);
    if (!show) {
      show = addMovie({
        trakt_id: 0,
        imdb_id: String(b.imdbId || ''),
        tmdb_id: tmdbId || null,
        title,
        year: Number(b.year) || 0,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        media_type: 'show',
        status: 'pending',
        desired_quality: quality,
        watchlist_source: 'seerr',
      });
      if (tvdbId) setMovieTvdbId(show.id, tvdbId);
      addLogEntry(null, 'show_added', `New show from Seerr: ${title}`);
      logger.info(`Sonarr endpoint: queued ${title} at ${quality}`);
    }

    // `monitored !== false` rather than `monitored === true`: a payload that
    // omits the flag used to yield an empty set, which left the season limit
    // unset — and the pipeline then discovered every season at the source. Seen
    // live: a request for two seasons produced a row with three.
    const requested: number[] = (b.seasons || [])
      .filter((s: any) => s?.monitored !== false && Number(s.seasonNumber) > 0)
      .map((s: any) => Number(s.seasonNumber));
    // Seerr always names the seasons it wants, so the set is closed: without
    // this the pipeline auto-discovers the rest of the show at the source.
    if (requested.length > 0) setSeasonsExplicit(show.id, true);
    const have = new Set(getSeasonsByShowId(show.id).map(s => s.season_number));
    let created = 0;
    for (const n of requested) {
      if (have.has(n)) continue;
      addSeason(show.id, n, quality);
      created++;
    }
    if (created > 0) logger.info(`Sonarr endpoint: ${title} — ${created} season(s) queued`);

    res.status(201).json({ id: show.id, title, tvdbId, monitored: true, seasons: b.seasons || [] });
  });

  return router;
}

export const radarrRouter = buildRouter('radarr');
export const sonarrRouter = buildRouter('sonarr');
