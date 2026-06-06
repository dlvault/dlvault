import { Router, Request, Response } from 'express';
import { getAllMovies, getMovieById, deleteMovie, updateMovieStatus, resetRetryCount, updateLastRetryAt, setSeasonCutoff, updateQualityOverride, addMovie, setRemovedAt, setRepairFlag, getMovieByImdbId, getMovieByTmdbId, getMovieByTitleYear, setMovieTmdbId, setMovieImdbId, type QualityOverride } from '../../database/services/movies';
import { getSetting } from '../../database/index';
import { traktService } from '../../services/trakt';
import { plexService } from '../../services/plex';
import { getDownloadsByMovieId } from '../../database/services/downloads';
import { addLogEntry, getLogsByMovieId } from '../../database/services/activityLog';
import { getSeasonsByShowId } from '../../database/services/seasons';
import { getEpisodesBySeasonId } from '../../database/services/episodes';
import { processMovie } from '../../services/scheduler';
import { isImporting } from '../../services/processingState';
import { enrichMovieMetadata } from '../../services/metadata';
import { logger } from '../../utils/logger';
import { parseUtcDate } from '../../utils/datetime';
import { clearDismissal, dismissTitle } from '../../database/services/dismissed';

const router = Router();

const RETRY_COOLDOWN_MS = 60 * 1000;

// POST /api/movies/manual-add — add a title from the unified search to dlvault,
// kick off the download pipeline, and sync it to the watchlist (Trakt now,
// Plex fast-follow). Body: { title, year?, imdbId?, tmdbId?, mediaType? }.
router.post('/manual-add', async (req: Request, res: Response) => {
  const { title, year, imdbId, tmdbId, mediaType } = req.body as {
    title?: string; year?: number; imdbId?: string; tmdbId?: number; mediaType?: 'movie' | 'show';
  };
  if (!title || !title.trim()) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  const mt: 'movie' | 'show' = mediaType === 'show' ? 'show' : 'movie';
  // Added again on purpose — an earlier removal no longer applies.
  clearDismissal({ mediaType: mt, tmdbId: tmdbId ?? null, imdbId: imdbId ?? null });

  try {
    // Scope the TMDb match to the requested media type — the movie and TV id
    // spaces overlap, so an unscoped lookup found a film for a requested show,
    // answered "already added" and kicked processMovie on the wrong title.
    let movie = (imdbId ? getMovieByImdbId(imdbId) : undefined)
      || (tmdbId ? getMovieByTmdbId(tmdbId, mt) : undefined);
    // Title + year only as a last resort, and never across two KNOWN ids:
    // three different 2026 films are called "Hungry". A match counts only when
    // one side has no id to tell them apart.
    if (!movie) {
      const sameName = getMovieByTitleYear(title, year, mt);
      const rowHasIds = !!(sameName?.tmdb_id || sameName?.imdb_id);
      const requestHasIds = !!(tmdbId || imdbId);
      if (sameName && (!rowHasIds || !requestHasIds)) {
        movie = sameName;
        // The id-less row learns which title it is.
        if (!rowHasIds && requestHasIds) {
          if (tmdbId) setMovieTmdbId(sameName.id, tmdbId);
          if (imdbId) setMovieImdbId(sameName.id, imdbId);
        }
      }
    }
    let created = false;
    if (!movie) {
      movie = addMovie({
        trakt_id: null as any,
        watchlist_source: 'manual',
        imdb_id: imdbId || null,
        tmdb_id: tmdbId || null,
        title: title.trim(),
        year: year || null,
        slug: title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        media_type: mt,
        status: 'pending',
        // Match the other add paths (plex/telegram/requests): honor the
        // configured minimum, not a hardcoded 1080p — otherwise a manual add
        // downloads 1080p and auto_upgrade immediately re-downloads it.
        desired_quality: getSetting('quality.minimum') || '1080p',
      });
      created = true;
      addLogEntry(movie.id, 'movie_added', `Manuell hinzugefügt: ${title.trim()}${year ? ` (${year})` : ''}`);
    }

    // Watchlist sync (best-effort, non-blocking).
    const provider = getSetting('watchlist.provider') || 'trakt';
    if (provider === 'trakt' || provider === 'both') {
      traktService.addToWatchlist({ imdb_id: imdbId, tmdb_id: tmdbId, title: title.trim(), year, mediaType: mt })
        .catch(() => { /* errors logged in service */ });
    }
    if (provider === 'plex' || provider === 'both') {
      plexService.addToWatchlist({ imdbId, tmdbId, title: title.trim(), year, mediaType: mt })
        .catch(() => { /* errors logged in service */ });
    }

    // Kick the pipeline so it searches + downloads now, not at the next sync.
    if (created || (movie.status !== 'downloaded' && movie.status !== 'downloading')) {
      processMovie(movie).catch(e => logger.warn(`manual-add processMovie failed: ${e?.message || e}`));
    }

    res.json({ ok: true, id: movie.id, title: movie.title, created });
  } catch (err: any) {
    logger.error(`manual-add failed: ${err?.message || err}`);
    res.status(500).json({ error: err?.message || 'add failed' });
  }
});

// A "candidate" is a source release the pipeline considered for this movie —
// every download row is a found release, every not_found log a miss. The detail
// panel groups these into a search-results list. `at` is raw UTC; the client
// renders it relative.
interface SearchCandidate {
  name: string;
  source: string;
  found: boolean;
  at: string;
  /** Why the round was rejected (quality_mismatch parenthetical) — misses only. */
  rejectionReason?: string;
}

function buildCandidates(movieId: number): SearchCandidate[] {
  const downloads = getDownloadsByMovieId(movieId);
  const logs = getLogsByMovieId(movieId);
  const candidates: SearchCandidate[] = [];

  for (const d of downloads) {
    candidates.push({
      name: d.release_name || d.download_url || 'Unbekanntes Release',
      source: d.hoster || '',
      found: true,
      at: d.created_at,
    });
  }
  for (const log of logs) {
    if (log.action === 'not_found') {
      candidates.push({
        name: log.details || 'Keine passende Quelle',
        source: '',
        found: false,
        at: log.created_at,
      });
    } else if (log.action === 'quality_mismatch') {
      // Releases existed but failed the filters — surface the per-axis reason
      // summary so the candidates list explains the miss instead of silently
      // skipping the round. The summary is the TRAILING parenthetical of the
      // log line (end-anchored, one nesting level for "(ausgeschlossen)") —
      // a first-paren match would grab the "(s)" of legacy "Release(s)" rows.
      const paren = log.details?.match(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/);
      candidates.push({
        name: 'Release gefunden, Anforderungen nicht erfüllt',
        source: '',
        found: false,
        at: log.created_at,
        rejectionReason: (paren ? paren[1] : log.details || '').trim() || undefined,
      });
    }
  }
  // Newest first.
  return candidates.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

// GET /api/movies — optional ?status= and ?media_type= filters (no param = all)
router.get('/', (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const mediaType = typeof req.query.media_type === 'string' ? req.query.media_type : undefined;
  let movies = getAllMovies();
  if (status) movies = movies.filter(m => m.status === status);
  if (mediaType) movies = movies.filter(m => m.media_type === mediaType);
  res.json(movies);
});

// GET /api/movies/:id
router.get('/:id', async (req: Request, res: Response) => {
  let movie = getMovieById(Number(req.params.id));
  if (!movie) {
    res.status(404).json({ error: 'Titel nicht gefunden' });
    return;
  }

  movie = await enrichMovieMetadata(movie);

  const downloads = getDownloadsByMovieId(movie.id);
  const logs = getLogsByMovieId(movie.id);
  // For shows, enrich each season with availability derived from the episodes
  // table: how many aired episodes are actually present (status 'downloaded',
  // kept in sync with the media server by the reconcile loop) vs. missing, plus
  // how many of the full season hasn't aired yet. The detail panel renders this
  // as a per-season "X/Y present + which episodes are missing" overview.
  const seasons = movie.media_type === 'show'
    ? getSeasonsByShowId(movie.id).map((s) => {
        const eps = getEpisodesBySeasonId(s.id);
        const downloaded = eps.filter((e) => e.status === 'downloaded').length;
        // Episode rows exist for aired episodes; aired_episodes is Trakt's count.
        const aired = Math.max(eps.length, s.aired_episodes ?? 0);
        const full = Math.max(aired, s.episode_count ?? 0);
        return {
          season_number: s.season_number,
          status: s.status,
          episodes_downloaded: downloaded,
          episodes_aired: aired,
          episodes_total: full,
          episodes_not_yet_aired: Math.max(0, full - aired),
          episodes_missing: eps.filter((e) => e.status !== 'downloaded').map((e) => e.episode_number),
          episodes_complete: aired > 0 && downloaded >= aired,
          // Below the show's cutoff → not monitored; the panel dims it as "übersprungen".
          skipped: movie!.season_cutoff != null && s.season_number < movie!.season_cutoff,
        };
      })
    : undefined;
  const candidates = buildCandidates(movie.id);
  res.json({ ...movie, downloads, logs, seasons, candidates });
});

// DELETE /api/movies/:id
router.delete('/:id', (req: Request, res: Response) => {
  if (isImporting(Number(req.params.id))) {
    // The import would go on writing to a row that no longer exists, and the
    // file would land in the library with no entry behind it.
    res.status(409).json({ error: 'Wird gerade in die Mediathek übernommen — gleich nochmal versuchen' });
    return;
  }
  try {
    // Remember the removal, or the next Seerr/Trakt/Plex sync adds it back.
    const doomed = getMovieById(Number(req.params.id));
    if (doomed) dismissTitle(doomed);
    deleteMovie(Number(req.params.id));
    res.json({ success: true });
  } catch (error: any) {
    logger.error(`Failed to delete movie ${req.params.id}:`, error.message);
    res.status(500).json({ error: 'Titel konnte nicht gelöscht werden' });
  }
});

// POST /api/movies/:id/retry
router.post('/:id/retry', async (req: Request, res: Response) => {
  const movie = getMovieById(Number(req.params.id));
  if (!movie) {
    res.status(404).json({ error: 'Titel nicht gefunden' });
    return;
  }

  // Note: we used to refuse retry while status === 'downloading'. That left a
  // movie permanently stuck whenever its JD download was removed/lost out from
  // under it (the status stayed 'downloading' with no package and no UI way to
  // restart). An explicit user-initiated retry now always resets + re-searches;
  // JDownloader's addLinks dedup skips a genuine duplicate if the package is in
  // fact still present, so this can't double-download an active one.

  // Being imported right now — a retry would find the JD package gone and
  // download the same film a second time.
  if (isImporting(movie.id)) {
    res.status(409).json({ success: false, message: 'Wird gerade in die Mediathek übernommen — gleich nochmal versuchen' });
    return;
  }

  // Rate limit: prevent spamming retries (60s cooldown per movie, persisted in DB)
  if (movie.last_retry_at) {
    const lastRetryMs = parseUtcDate(movie.last_retry_at);
    const elapsed = Date.now() - lastRetryMs;
    if (elapsed < RETRY_COOLDOWN_MS) {
      const remainingSec = Math.ceil((RETRY_COOLDOWN_MS - elapsed) / 1000);
      res.status(429).json({ success: false, message: `Bitte warte ${remainingSec}s vor der nächsten Suche` });
      return;
    }
  }
  updateLastRetryAt(movie.id);

  updateMovieStatus(movie.id, 'pending');
  resetRetryCount(movie.id);
  logger.info(`Manual retry for: ${movie.title}`);

  // Re-fetch movie with updated status so processMovie sees 'pending'
  const updatedMovie = getMovieById(movie.id);
  if (!updatedMovie) {
    res.status(404).json({ error: 'Titel wurde während der Suche gelöscht' });
    return;
  }

  // Process immediately in background
  processMovie(updatedMovie, { manual: true }).catch(err => {
    logger.error(`Retry error for ${movie.title}:`, err.message);
  });

  res.json({ success: true, message: 'Neue Suche gestartet' });
});

// POST /api/movies/:id/redownload — a film gone from the library, fetched
// again on the user's word (problem center). Marked as repair so the media
// server, which may still list the old item, does not stop the search.
router.post('/:id/redownload', async (req: Request, res: Response) => {
  const movie = getMovieById(Number(req.params.id));
  if (!movie) { res.status(404).json({ error: 'Titel nicht gefunden' }); return; }
  if (isImporting(movie.id)) {
    res.status(409).json({ success: false, message: 'Wird gerade in die Mediathek übernommen — gleich nochmal versuchen' });
    return;
  }
  setRemovedAt(movie.id, false);
  setRepairFlag(movie.id, true);
  updateMovieStatus(movie.id, 'pending');
  resetRetryCount(movie.id);
  addLogEntry(movie.id, 'repair', 'Fehlte in der Mediathek — auf Wunsch neu geladen');
  logger.info(`Re-download requested: ${movie.title}`);
  const fresh = getMovieById(movie.id);
  if (fresh) processMovie(fresh, { manual: true }).catch(err => logger.error(`Re-download ${movie.title}: ${err.message}`));
  res.json({ success: true });
});

// POST /api/movies/:id/mark-removed — the user deleted it on purpose; stop asking.
router.post('/:id/mark-removed', (req: Request, res: Response) => {
  const movie = getMovieById(Number(req.params.id));
  if (!movie) { res.status(404).json({ error: 'Titel nicht gefunden' }); return; }
  setRemovedAt(movie.id, true);
  addLogEntry(movie.id, 'library_removed', 'Als absichtlich gelöscht markiert — wird nicht neu geladen');
  res.json({ success: true });
});

// PUT /api/movies/:id/season-cutoff — shows only. Body: { cutoff: number | null }.
// Sets "download only from season N onwards"; null clears it (monitor all).
// Already downloaded/downloading seasons below the cutoff are left as-is — this
// only gates future scheduler work (see processShowSeasons).
router.put('/:id/season-cutoff', (req: Request, res: Response) => {
  const movie = getMovieById(Number(req.params.id));
  if (!movie) {
    res.status(404).json({ error: 'Titel nicht gefunden' });
    return;
  }
  if (movie.media_type !== 'show') {
    res.status(400).json({ error: 'Die Staffel-Auswahl gibt es nur für Serien' });
    return;
  }

  const raw = (req.body ?? {}).cutoff;
  let cutoff: number | null;
  if (raw === null || raw === undefined || raw === '') {
    cutoff = null;
  } else {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      res.status(400).json({ error: 'cutoff must be a positive integer or null' });
      return;
    }
    cutoff = n;
  }

  setSeasonCutoff(movie.id, cutoff);
  addLogEntry(
    movie.id,
    'season_cutoff_set',
    cutoff == null ? 'Staffel-Filter aufgehoben — alle Staffeln' : `Download ab Staffel ${cutoff}`,
  );
  logger.info(`${movie.title}: season cutoff set to ${cutoff ?? 'none'}`);
  res.json({ success: true, season_cutoff: cutoff });
});

// PUT /api/movies/:id/quality-override — Body: { mode: 'relaxed' | 'any' | null }.
// Per-title quality-filter override for the "Anforderungen nicht erfüllt" bucket:
// 'relaxed' drops the minimum thresholds + type exclusions but keeps the language,
// 'any' accepts every release with links, null restores the global filter. Only
// sets the persisted value — the re-search is triggered separately via /retry so
// the existing retry cooldown applies unchanged.
router.put('/:id/quality-override', (req: Request, res: Response) => {
  const movie = getMovieById(Number(req.params.id));
  if (!movie) {
    res.status(404).json({ error: 'Titel nicht gefunden' });
    return;
  }

  const raw = (req.body ?? {}).mode;
  let mode: QualityOverride | null;
  if (raw === null || raw === undefined || raw === '') {
    mode = null;
  } else if (raw === 'relaxed' || raw === 'any') {
    mode = raw;
  } else {
    res.status(400).json({ error: "mode must be 'relaxed', 'any' or null" });
    return;
  }

  updateQualityOverride(movie.id, mode);
  addLogEntry(
    movie.id,
    'quality_override_set',
    mode == null
      ? 'Qualitätsfilter zurückgesetzt — globale Einstellungen'
      : mode === 'relaxed'
        ? 'Qualitätsfilter gelockert — beste Version in gewünschter Sprache'
        : 'Qualitätsfilter aufgehoben — jedes Release akzeptiert',
  );
  logger.info(`${movie.title}: quality override set to ${mode ?? 'none'}`);
  res.json({ success: true, quality_override: mode });
});

export default router;
