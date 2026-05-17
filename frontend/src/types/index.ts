export interface Movie {
  id: number;
  title: string;
  year: number;
  imdb_id?: string;
  tmdb_id?: number;
  status: 'pending' | 'searching' | 'found' | 'downloading' | 'downloaded' | 'not_found';
  desired_quality: string;
  source_url?: string;
  media_type?: 'movie' | 'show';
  last_checked_at?: string;
  created_at: string;
}

export interface LogEntry {
  id: number;
  movie_title?: string;
  action: string;
  details?: string;
  created_at: string;
}

export interface SyncStatus {
  schedulerRunning: boolean;
  syncRunning: boolean;
  totalMovies: number;
  pending: number;
  searching: number;
  found: number;
  downloading: number;
  downloaded: number;
  notFound: number;
}

export interface DownloadPackage {
  uuid: number;
  name: string;
  bytesLoaded: number;
  bytesTotal: number;
  speed: number;
  eta: number;
  running: boolean;
  finished: boolean;
  enabled: boolean;
  status?: string;
  statusIconKey?: string;
  saveTo?: string;
  isExtracting?: boolean;
  extractionProgress?: number;
  isMoved?: boolean;
}

export interface LibraryItem {
  id: string;
  name: string;
  year: number;
  mediaType: 'movie' | 'show';
  posterUrl?: string;
}

export interface ServiceStatus {
  connected: boolean;
  serverName?: string;
  username?: string;
  movieCount?: number;
}

export interface JDStatus {
  configured: boolean;
  connected: boolean;
  devices: { name: string }[];
}

export interface TraktStatus {
  configured: boolean;
  authenticated: boolean;
  username: string;
}

export interface MovieDetail extends Movie {
  added_at: string;
  downloads: {
    id: number;
    quality: string;
    release_name?: string;
    hoster?: string;
  }[];
  logs: LogEntry[];
}

export interface DownloadReleasePayload {
  title: string;
  url: string;
  year?: number;
  quality?: string;
  hoster?: string;
}

export interface SSEPayload {
  [key: string]: unknown;
}
