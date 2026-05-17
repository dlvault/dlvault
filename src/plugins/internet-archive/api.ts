import type { PluginHttpClient, PluginLogger } from '../context';

const IA_BASE = 'https://archive.org';

export interface IASearchDoc {
  identifier: string;
  title: string;
  year?: number;
  creator?: string;
  description?: string;
  subject?: string | string[];
  downloads?: number;
}

export interface IAFile {
  name: string;
  format: string;
  size?: string;
  length?: string;
  source?: string;
}

export interface IAMetadata {
  metadata: {
    title?: string;
    year?: string;
    identifier?: string;
    description?: string;
    creator?: string;
  };
  files: IAFile[];
}

interface SearchOpts {
  q?: string;
  year?: number;
  collection?: string;
  rows?: number;
  sort?: string;
}

export interface IAApi {
  search(opts: SearchOpts): Promise<IASearchDoc[]>;
  metadata(identifier: string): Promise<IAMetadata | null>;
}

/**
 * Factory for the IA API client. Receives the host's injected HTTP client +
 * logger via the plugin context, so the plugin itself never imports axios.
 * That's the pattern external plugin authors should follow.
 */
export function createIAApi(http: PluginHttpClient, logger: PluginLogger): IAApi {
  return {
    async search(opts: SearchOpts): Promise<IASearchDoc[]> {
      const parts: string[] = ['mediatype:movies'];
      if (opts.q) {
        const escaped = opts.q.replace(/"/g, '\\"');
        parts.push(`(title:"${escaped}" OR creator:"${escaped}")`);
      }
      if (opts.year) parts.push(`year:${opts.year}`);
      if (opts.collection) parts.push(`collection:${opts.collection}`);

      const params: Record<string, unknown> = {
        q: parts.join(' AND '),
        output: 'json',
        rows: opts.rows ?? 20,
        'fl[]': ['identifier', 'title', 'year', 'creator', 'description', 'subject', 'downloads'],
      };
      if (opts.sort) params['sort[]'] = opts.sort;

      try {
        const res = await http.get<{ response?: { docs?: IASearchDoc[] } }>(
          `${IA_BASE}/advancedsearch.php`,
          { params },
        );
        return res.data?.response?.docs || [];
      } catch (err: any) {
        logger.debug(`search failed: ${err?.message || err}`);
        return [];
      }
    },

    async metadata(identifier: string): Promise<IAMetadata | null> {
      try {
        const res = await http.get<IAMetadata>(
          `${IA_BASE}/metadata/${encodeURIComponent(identifier)}`,
        );
        if (!res.data || !Array.isArray(res.data.files)) return null;
        return res.data;
      } catch (err: any) {
        logger.debug(`metadata failed for ${identifier}: ${err?.message || err}`);
        return null;
      }
    },
  };
}

// Pure URL helpers — no HTTP, can stay as plain functions.
export function posterUrl(identifier: string): string {
  return `${IA_BASE}/services/img/${encodeURIComponent(identifier)}`;
}

export function fileUrl(identifier: string, filename: string): string {
  return `${IA_BASE}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(filename)}`;
}

export function detailUrl(identifier: string): string {
  return `${IA_BASE}/details/${encodeURIComponent(identifier)}`;
}
