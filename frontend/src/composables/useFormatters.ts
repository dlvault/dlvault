export function formatDate(d: string, opts?: Intl.DateTimeFormatOptions) {
  return new Date(d + 'Z').toLocaleString('de-DE', opts ?? {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function formatDateFull(d: string) {
  return new Date(d + 'Z').toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function timeAgo(d: string): string {
  const now = Date.now();
  const then = new Date(d + 'Z').getTime();
  const diff = Math.max(0, Math.floor((now - then) / 1000));

  if (diff < 60) return 'gerade eben';
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return `vor ${m} Min`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return `vor ${h} Std`;
  }
  if (diff < 604800) {
    const days = Math.floor(diff / 86400);
    return `vor ${days} Tag${days > 1 ? 'en' : ''}`;
  }
  // Older than a week — show absolute date
  return formatDate(d);
}

// Canonical compact stage vocabulary — single source for badges, chips and the
// command palette. Verbose variants (group headers, DetailPanel) stay local.
const statusLabels: Record<string, string> = {
  pending: 'Wartet',
  searching: 'Suche',
  found: 'Gefunden',
  downloading: 'Lädt',
  extracting: 'Entpacken',
  moved: 'Verschoben',
  downloaded: 'In Mediathek',
  not_found: 'Nicht gefunden',
  // Sub-buckets of not_found, derived from movie.not_found_reason (see displayStatus).
  not_available: 'Kein Release bei der Quelle',
  no_download: 'Kein Download',
  // "quality_mismatch" is broader than its name: a release was found but failed
  // the filter on resolution, AUDIO, language, or release type. With a permissive
  // video setting (e.g. 1080p+ unlimited) the real cause is usually audio/language,
  // so the label avoids claiming it's purely about resolution.
  quality_mismatch: 'Anforderungen nicht erfüllt',
};

export function statusLabel(status: string): string {
  return statusLabels[status] || status;
}

/**
 * The status to render for a movie/season row. For 'not_found' rows this resolves
 * the not_found_reason into one of three display buckets so badges and grouping
 * show *why* it wasn't downloaded instead of a generic "Nicht gefunden". Legacy
 * rows without a reason fall back to 'not_available'. All other statuses pass
 * through unchanged.
 */
export function displayStatus(m: { status: string; not_found_reason?: string | null }): string {
  if (m.status !== 'not_found') return m.status;
  switch (m.not_found_reason) {
    case 'quality_mismatch': return 'quality_mismatch';
    case 'no_download': return 'no_download';
    default: return 'not_available';
  }
}

// German labels for every backend log action. The raw log.details written by
// the backend stay English (and remain so in the technical Logs view); the
// user-facing activity feed (DetailPanel, dashboard ActivityStream) renders
// these localized labels instead. A real i18n layer is planned separately.
const actionLabels: Record<string, string> = {
  movie_added: 'Hinzugefügt',
  show_added: 'Serie hinzugefügt',
  season_added: 'Staffel hinzugefügt',
  seasons_added: 'Staffeln hinzugefügt',
  seasons_synced: 'Neue Staffeln erkannt',
  season_discovered: 'Neue Staffel an der Quelle',
  watchlist_sync: 'Watchlist synchronisiert',
  sync_started: 'Sync gestartet',
  sync_completed: 'Sync abgeschlossen',
  search_started: 'Suche gestartet',
  release_found: 'Quelle gefunden',
  not_found: 'Keine Quelle gefunden',
  quality_mismatch: 'Anforderungen nicht erfüllt',
  no_hoster: 'Kein Hoster',
  resolving_links: 'Links werden aufgelöst',
  captcha_pending: 'Links nicht aufgelöst — neuer Versuch',
  sent_to_jdownloader: 'An JDownloader gesendet',
  download_finished: 'Download abgeschlossen',
  download_stale: 'Download hängt fest',
  linkgrabber_stuck: 'Linkgrabber hängt fest',
  links_offline: 'Links offline',
  extraction_started: 'Entpacken gestartet',
  extraction_finished: 'Entpacken abgeschlossen',
  moved_to_library: 'In die Library verschoben',
  library_import: 'Als heruntergeladen markiert',
  library_reconciled: 'Library abgeglichen',
  reconcile: 'Status korrigiert',
  auto_reset: 'Auf „ausstehend“ zurückgesetzt',
  quality_upgrade: 'Qualitäts-Upgrade',
  already_in_library: 'Bereits in der Library',
  movie_removed: 'Aus Watchlist entfernt',
  jdownloader_error: 'JDownloader-Fehler',
  jdownloader_failed: 'JDownloader fehlgeschlagen',
  error: 'Fehler',
};

export function formatAction(action: string): string {
  return actionLabels[action] || action.replace(/_/g, ' ');
}

/**
 * The trailing parenthetical of a log detail line, e.g. the reason summary in
 * "3 Releases gefunden, aber keins erfüllt die Anforderungen (2 unter
 * Audio-Mindest; gewünscht ≥ 1080p)". End-anchored with one nesting level
 * ("… Dolby Vision (ausgeschlossen); …") — a naive first-paren match would
 * grab the "(s)" of legacy "Release(s)" rows instead of the reason.
 */
export function trailingParenthetical(s: string): string | null {
  const m = s.match(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/);
  return m ? m[1].trim() : null;
}

// Short German tag for the mono action-pill in activity feeds.
const actionVerbs: Record<string, string> = {
  movie_added: 'neu', show_added: 'neu', season_added: 'neu', seasons_added: 'neu',
  seasons_synced: 'sync', season_discovered: 'neu', season_cutoff_set: 'filter',
  quality_override_set: 'filter',
  watchlist_sync: 'sync', sync_started: 'sync', sync_completed: 'sync',
  search_started: 'suche', release_found: 'gefunden', not_found: 'nichts',
  quality_mismatch: 'qualität', no_hoster: 'kein hoster',
  resolving_links: 'auflösen', captcha_pending: 'retry',
  sent_to_jdownloader: 'gesendet', download_finished: 'fertig',
  download_stale: 'hängt', linkgrabber_stuck: 'hängt', links_offline: 'offline',
  extraction_started: 'entpacken', extraction_finished: 'entpackt',
  moved_to_library: 'verschoben', library_import: 'library',
  library_reconciled: 'abgleich', reconcile: 'korrektur', auto_reset: 'reset',
  quality_upgrade: 'upgrade', already_in_library: 'vorhanden',
  movie_removed: 'entfernt', error: 'fehler',
  jdownloader_error: 'jd-fehler', jdownloader_failed: 'jd-fehler',
};

export function activityVerb(action: string): string {
  return actionVerbs[action] || action.replace(/_/g, ' ');
}

// German descriptive line for an activity entry. Starts from the localized
// action label and appends a language-neutral fragment pulled from the English
// detail (counts, sizes, paths, error text) so no information is lost.
export function activityText(action: string, details?: string | null): string {
  const label = actionLabels[action];
  const d = details || '';
  if (!label) {
    // Unknown action: fall back to the raw detail, else a de-underscored action.
    return d || action.replace(/_/g, ' ');
  }
  let suffix = '';
  switch (action) {
    case 'not_found': {
      const m = d.match(/retry\s+(\d+\/\d+)/i);
      if (m) suffix = ` · Versuch ${m[1]}`;
      break;
    }
    case 'quality_mismatch': {
      // Surface the concrete failure axis from the detail, e.g.
      // "…Anforderungen (3 unter Audio-Mindest; gewünscht ≥ 1080p)".
      const reason = trailingParenthetical(d);
      if (reason) suffix = ` · ${reason}`;
      break;
    }
    case 'sent_to_jdownloader': {
      const m = d.match(/(\d+)\s+link/i);
      if (m) suffix = ` · ${m[1]} Links`;
      break;
    }
    case 'watchlist_sync': {
      const m = d.match(/(\d+)\s+added,\s+(\d+)\s+removed/i);
      if (m) suffix = ` · ${m[1]} neu, ${m[2]} entfernt`;
      break;
    }
    case 'sync_completed': {
      const m = d.match(/(\d+)\s+new,\s+(\d+)\s+processed/i);
      if (m) suffix = ` · ${m[1]} neu, ${m[2]} verarbeitet`;
      break;
    }
    case 'moved_to_library': {
      const m = d.match(/library:\s+(.+)$/i);
      if (m) suffix = ` · ${m[1]}`;
      break;
    }
    case 'library_import': {
      const m = d.match(/found in ([^:]+):/i);
      if (m) suffix = ` · ${m[1].trim()}`;
      break;
    }
    case 'error':
    case 'jdownloader_error':
    case 'jdownloader_failed':
      // Errors carry a technical message worth surfacing verbatim.
      if (d) suffix = ` · ${d}`;
      break;
  }
  return label + suffix;
}

export function actionColor(action: string): string {
  if (['release_found', 'sent_to_jdownloader', 'sync_completed'].includes(action)) return 'found';
  if (['not_found', 'quality_mismatch', 'error', 'jdownloader_error', 'no_hoster', 'links_offline'].includes(action)) return 'not_found';
  if (['search_started', 'sync_started'].includes(action)) return 'searching';
  return 'pending';
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

export function formatSpeed(bps: number): string {
  if (!bps) return '0 KB/s';
  if (bps > 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
  return (bps / 1024).toFixed(0) + ' KB/s';
}

export function sourceHost(url: string | null | undefined): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

// Deterministic fallback gradient per title — the same movie always gets the
// same look, shared across poster tiles (MoviePoster, LibraryPoster) and the
// DetailPanel hero so a title never changes its color between views.
const POSTER_GRADIENTS = [
  'linear-gradient(160deg, #1a3a5c 0%, #0d1a2c 70%, #2a1a3a 100%)',
  'linear-gradient(150deg, #3a1a2c 0%, #1a0d1a 60%, #2a1f3a 100%)',
  'linear-gradient(160deg, #2c3a1a 0%, #1a2c0d 70%, #1f3a2a 100%)',
  'linear-gradient(140deg, #3a2c1a 0%, #1a1a0d 60%, #3a1a1f 100%)',
  'linear-gradient(170deg, #1a2c3a 0%, #0d1a2c 60%, #1a1f3a 100%)',
  'linear-gradient(155deg, #3a1a3a 0%, #1a0d2c 70%, #1a2c3a 100%)',
  'linear-gradient(145deg, #2c1a3a 0%, #0d1a1a 70%, #3a2c1a 100%)',
  'linear-gradient(165deg, #1a3a3a 0%, #0d1a1a 60%, #1a2c3a 100%)',
  'linear-gradient(155deg, #5c2a1a 0%, #2c0d0d 60%, #3a1a2c 100%)',
  'linear-gradient(165deg, #2a1a5c 0%, #0d0d2c 60%, #1f1a3a 100%)',
];

export function posterGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return POSTER_GRADIENTS[h % POSTER_GRADIENTS.length];
}

export function formatEta(seconds: number): string {
  if (seconds <= 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
