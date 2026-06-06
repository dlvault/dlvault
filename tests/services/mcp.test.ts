import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store, movies, logged } = vi.hoisted(() => ({ store: {} as Record<string, string>, movies: [] as any[], logged: [] as any[] }));
vi.mock('../../src/database/index', () => ({
  getSetting: (k: string) => store[k] ?? '',
  setSetting: (k: string, v: string) => { store[k] = v; },
  default: { prepare: () => ({ get: () => ({ c: 4 }), all: () => [] }) },
}));
vi.mock('../../src/database/services/movies', () => ({
  getAllMovies: () => movies,
  getMovieById: (id: number) => movies.find(m => m.id === id),
  updateMovieStatus: (id: number, s: string) => { movies.find(m => m.id === id).status = s; },
  resetRetryCount: vi.fn(), setRemovedAt: vi.fn(), setRepairFlag: vi.fn(),
}));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: (...a: any[]) => logged.push(a) }));
vi.mock('../../src/services/problems', () => ({ collectProblems: () => [] }));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { handleRpc, isPrivateAddress, fromPrivateNetwork } from '../../src/mcp/server';
import { createToken, verifyToken, revokeToken, listTokens } from '../../src/mcp/tokens';
import { toolDocs } from '../../src/mcp/docs';
import { TOOLS } from '../../src/mcp/tools';

const rd: any = { id: 'a', name: 'KI', scope: 'read' };
const wr: any = { id: 'b', name: 'KI', scope: 'write' };
const call = (name: string, args: any, tok = wr) => (handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tok) as any).result;
const list = (tok: any) => (handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tok) as any).result.tools.map((t: any) => t.name);

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  movies.length = 0; logged.length = 0;
  movies.push({ id: 1, title: 'Film', year: 2020, media_type: 'movie', status: 'not_found', added_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' });
});

describe('tokens', () => {
  it('stores only a hash and verifies the clear token', () => {
    const { token } = createToken('Lexi', 'read');
    expect(JSON.stringify(listTokens())).not.toContain(token);
    expect(verifyToken(token)?.name).toBe('Lexi');
    expect(verifyToken(token + 'x')).toBeNull();
  });
  it('revokes', () => {
    const { token, entry } = createToken('x', 'write');
    expect(revokeToken(entry.id)).toBe(true);
    expect(verifyToken(token)).toBeNull();
  });
});

describe('network', () => {
  it('accepts private ranges only', () => {
    for (const a of ['192.168.1.5', '10.0.0.2', '172.17.0.1', '127.0.0.1', '::1', '::ffff:192.168.1.5', '100.101.2.3']) expect(isPrivateAddress(a)).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', undefined, '']) expect(isPrivateAddress(a as any)).toBe(false);
  });
});

describe('network behind a reverse proxy', () => {
  const req = (headers: Record<string, string | string[]>, peer = '172.17.0.5') => ({ socket: { remoteAddress: peer }, headers }) as any;
  it('accepts a LAN client, direct or through the proxy', () => {
    expect(fromPrivateNetwork(req({}, '192.168.0.20'))).toBe(true);
    expect(fromPrivateNetwork(req({ 'x-forwarded-for': '192.168.0.20', 'x-real-ip': '192.168.0.20' }))).toBe(true);
    expect(fromPrivateNetwork(req({ forwarded: 'for="[fd00::7]:4711";proto=https, for=10.0.0.3:80' }))).toBe(true);
  });
  it('refuses an internet client the proxy forwarded, even with a forged private entry', () => {
    expect(fromPrivateNetwork(req({ 'x-forwarded-for': '8.8.8.8' }))).toBe(false);
    expect(fromPrivateNetwork(req({ 'x-forwarded-for': '192.168.0.20, 8.8.8.8' }))).toBe(false);
    expect(fromPrivateNetwork(req({ 'x-real-ip': '8.8.8.8' }))).toBe(false);
    expect(fromPrivateNetwork(req({ forwarded: 'for="8.8.8.8:4711"' }))).toBe(false);
    expect(fromPrivateNetwork(req({ forwarded: 'for=unknown' }))).toBe(false);
  });
});

describe('groups and scopes', () => {
  it('offers nothing while every group is off', () => {
    expect(list(wr)).toEqual([]);
  });
  it('offers a group only when it is switched on', () => {
    store['mcp.group.report'] = 'true';
    expect(list(wr)).toEqual(['status', 'morning_report', 'list_titles']);
  });
  it('hides write tools from a read token', () => {
    store['mcp.group.heal'] = 'true';
    expect(list(rd)).toEqual(['problems']);
    expect(list(wr)).toEqual(['problems', 'retry_title']);
  });
  it('refuses a call into a switched-off group', () => {
    expect(call('status', {}).isError).toBe(true);
  });
});

describe('writes', () => {
  beforeEach(() => { store['mcp.group.heal'] = 'true'; });
  it('needs confirm', () => {
    expect(call('retry_title', { id: 1 }).isError).toBe(true);
    expect(movies[0].status).toBe('not_found');
  });
  it('is refused for a read token', () => {
    expect(call('retry_title', { id: 1, confirm: true }, rd).isError).toBe(true);
    expect(movies[0].status).toBe('not_found');
  });
  it('changes state and leaves a trace', () => {
    const r = call('retry_title', { id: 1, confirm: true });
    expect(r.isError).toBe(false);
    expect(movies[0].status).toBe('pending');
    expect(logged.some(l => l[1] === 'mcp')).toBe(true);
  });
  it('reports an unknown title as an error', () => {
    expect(call('retry_title', { id: 99, confirm: true }).isError).toBe(true);
  });
});

describe('protocol and docs', () => {
  it('answers initialize and ignores notifications', () => {
    expect((handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, rd) as any).result.serverInfo.name).toBe('dlvault');
    expect(handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, rd)).toBeNull();
  });
  it('rejects an unknown method', () => {
    expect((handleRpc({ jsonrpc: '2.0', id: 1, method: 'nope' }, rd) as any).error.code).toBe(-32601);
  });
  it('documents every tool (drift guard)', () => {
    const docs = toolDocs();
    for (const t of TOOLS) expect(docs).toContain(`**${t.name}**`);
  });
});
