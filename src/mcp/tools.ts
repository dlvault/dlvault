import db, { getSetting } from '../database/index';
import {
  getAllMovies, getMovieById, updateMovieStatus, resetRetryCount, setRemovedAt, setRepairFlag,
} from '../database/services/movies';
import { addLogEntry } from '../database/services/activityLog';
import { collectProblems } from '../services/problems';

/**
 * The tools an AI may call. ONE registry drives everything: the tools/list
 * answer, the permission checks and the generated documentation (see
 * docs.ts) — so a tool cannot exist without a description.
 *
 * Groups can be switched on and off in the settings (`mcp.group.<id>`, default
 * off). Write tools additionally need a write token and `confirm: true`; they
 * only change state and never start a source search themselves — the scheduler
 * does that under its own search budget.
 */
export type McpGroup = 'report' | 'heal' | 'library';

export const GROUPS: Record<McpGroup, { label: string; description: string }> = {
  report: { label: 'Morgenbericht', description: 'Liest: was ist über Nacht passiert, Zahlen, Titelliste.' },
  heal: { label: 'Selbstheilung', description: 'Probleme erkennen und Titel neu suchen lassen (die Suche selbst macht der Planer).' },
  library: { label: 'Bibliothek pflegen', description: 'Titel als entfernt markieren oder erneut laden lassen.' },
};

export interface McpTool {
  name: string;
  group: McpGroup;
  write: boolean;
  description: string;
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required: string[];
  run(args: Record<string, any>): unknown;
}

const num = (v: unknown): number => Number(v);
const MAX_LIST = 200;

function titleRow(m: any) {
  return { id: m.id, title: m.title, year: m.year, type: m.media_type, status: m.status, notFoundReason: m.not_found_reason ?? null, addedAt: m.added_at, downloadedAt: m.downloaded_at ?? null };
}

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of getAllMovies()) out[m.status] = (out[m.status] || 0) + 1;
  return out;
}

function searchCount(mod: string): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE action = 'search_started' AND created_at >= datetime('now', ?)").get(mod) as { c: number }).c;
}

function need(args: Record<string, any>) {
  const m = getMovieById(num(args.id));
  if (!m) throw new Error(`Titel ${args.id} nicht gefunden`);
  return m;
}

export const TOOLS: McpTool[] = [
  {
    name: 'status', group: 'report', write: false,
    description: 'Zahlen auf einen Blick: Titel je Status und gestartete Quellen-Suchen (letzte Stunde, 24 h, 7 Tage).',
    properties: {}, required: [],
    run: () => ({ titles: counts(), searches: { lastHour: searchCount('-1 hour'), last24h: searchCount('-24 hours'), last7d: searchCount('-7 days') } }),
  },
  {
    name: 'morning_report', group: 'report', write: false,
    description: 'Morgenbericht: was in den letzten Stunden geladen wurde, was neu nicht gefunden ist, offene Probleme.',
    properties: { hours: { type: 'number', description: 'Zeitraum in Stunden (Vorgabe 24, höchstens 168).' } }, required: [],
    run: (a) => {
      const hours = Math.min(168, Math.max(1, Math.round(num(a.hours) || 24)));
      const since = Date.now() - hours * 3600e3;
      const all = getAllMovies();
      const at = (s: string | null | undefined) => (s ? Date.parse(s.replace(' ', 'T') + 'Z') : NaN);
      const downloaded = all.filter(m => at(m.downloaded_at) >= since).map(titleRow);
      const notFound = all.filter(m => m.status === 'not_found' && at(m.updated_at) >= since).map(titleRow);
      const problems = collectProblems();
      return { hours, downloaded, notFoundNew: notFound, problems: problems.slice(0, 20), problemCount: problems.length, titles: counts() };
    },
  },
  {
    name: 'list_titles', group: 'report', write: false,
    description: 'Titel auflisten, optional nach Status gefiltert.',
    properties: {
      status: { type: 'string', description: 'Status-Filter.', enum: ['pending', 'searching', 'found', 'downloading', 'downloaded', 'not_found'] },
      limit: { type: 'number', description: `Anzahl (Vorgabe 50, höchstens ${MAX_LIST}).` },
    }, required: [],
    run: (a) => {
      const limit = Math.min(MAX_LIST, Math.max(1, Math.round(num(a.limit) || 50)));
      return getAllMovies().filter(m => !a.status || m.status === a.status).slice(0, limit).map(titleRow);
    },
  },
  {
    name: 'problems', group: 'heal', write: false,
    description: 'Alles, was Aufmerksamkeit braucht (wie das Problem-Center), das Schwerste zuerst.',
    properties: {}, required: [],
    run: () => collectProblems(),
  },
  {
    name: 'retry_title', group: 'heal', write: true,
    description: 'Einen Titel zurück auf „pending“ setzen und den Zähler leeren. Gesucht wird beim nächsten Planer-Lauf, innerhalb des Such-Budgets — nicht sofort.',
    properties: { id: { type: 'number', description: 'Titel-ID.' } }, required: ['id'],
    run: (a) => {
      const m = need(a);
      updateMovieStatus(m.id, 'pending');
      resetRetryCount(m.id);
      addLogEntry(m.id, 'mcp', 'Neue Suche vorgemerkt (KI-Schnittstelle)');
      return { ok: true, id: m.id, title: m.title };
    },
  },
  {
    name: 'mark_removed', group: 'library', write: true,
    description: 'Einen Titel als aus der Bibliothek entfernt markieren (löscht keine Dateien).',
    properties: { id: { type: 'number', description: 'Titel-ID.' }, removed: { type: 'boolean', description: 'true = entfernt, false = wieder aufheben (Vorgabe true).' } }, required: ['id'],
    run: (a) => {
      const m = need(a);
      const removed = a.removed !== false;
      setRemovedAt(m.id, removed);
      addLogEntry(m.id, 'mcp', removed ? 'Als entfernt markiert (KI-Schnittstelle)' : 'Entfernt-Markierung aufgehoben (KI-Schnittstelle)');
      return { ok: true, id: m.id, title: m.title, removed };
    },
  },
  {
    name: 'redownload_title', group: 'library', write: true,
    description: 'Einen in der Bibliothek fehlenden Titel erneut laden lassen (Reparatur-Markierung + pending). Gesucht wird vom Planer, nicht sofort.',
    properties: { id: { type: 'number', description: 'Titel-ID.' } }, required: ['id'],
    run: (a) => {
      const m = need(a);
      setRemovedAt(m.id, false);
      setRepairFlag(m.id, true);
      updateMovieStatus(m.id, 'pending');
      resetRetryCount(m.id);
      addLogEntry(m.id, 'repair', 'Neu laden vorgemerkt (KI-Schnittstelle)');
      return { ok: true, id: m.id, title: m.title };
    },
  },
];

export function groupEnabled(g: McpGroup): boolean {
  return getSetting(`mcp.group.${g}`) === 'true';
}

export function mcpEnabled(): boolean {
  return getSetting('mcp.enabled') === 'true';
}
