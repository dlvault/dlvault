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

const statusLabels: Record<string, string> = {
  pending: 'Ausstehend',
  searching: 'Suche...',
  found: 'Gefunden',
  downloading: 'Wird geladen',
  extracting: 'Entpacken',
  downloaded: 'Fertig',
  not_found: 'Nicht gefunden',
};

export function statusLabel(status: string): string {
  return statusLabels[status] || status;
}

const actionLabels: Record<string, string> = {
  movie_added: 'Hinzugefügt',
  watchlist_sync: 'Watchlist Sync',
  search_started: 'Suche gestartet',
  not_found: 'Nicht gefunden',
  quality_mismatch: 'Qualität passt nicht',
  no_hoster: 'Kein Hoster',
  release_found: 'Release gefunden',
  sent_to_jdownloader: 'An JDownloader',
  jdownloader_error: 'JDownloader Fehler',
  links_offline: 'Links offline',
  sync_started: 'Sync Start',
  sync_completed: 'Sync fertig',
  error: 'Fehler',
};

export function formatAction(action: string): string {
  return actionLabels[action] || action;
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

export function formatEta(seconds: number): string {
  if (seconds <= 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
