import { Router, Request, Response } from 'express';
import { verifyToken, touchToken, type McpToken } from './tokens';
import { TOOLS, GROUPS, groupEnabled, mcpEnabled, type McpTool } from './tools';
import { logger } from '../utils/logger';
import { addLogEntry } from '../database/services/activityLog';

/**
 * MCP over HTTP (JSON-RPC 2.0, POST /mcp). Off unless `mcp.enabled` is true.
 * Own bearer-token auth (see tokens.ts), private networks only, and every
 * write is recorded in the activity log. Deliberately dependency-free: only
 * initialize, ping, tools/list and tools/call are needed.
 */

const PROTOCOL = '2025-03-26';

export function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  if (a === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)) return true;
  const m = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127);
}

/** RFC 7239 node → bare address: drop quotes, [brackets] and an IPv4 port. */
function forwardedNode(raw: string): string {
  const v = raw.replace(/^"|"$/g, '');
  const bracketed = /^\[([^\]]+)\]/.exec(v);
  if (bracketed) return bracketed[1];
  return v.split(':').length === 2 ? v.split(':')[0] : v;
}

/**
 * Every address the request passed through: the socket peer plus each hop a
 * proxy recorded (X-Forwarded-For, X-Real-IP, Forwarded). Behind a reverse proxy
 * on the LAN the socket peer is the proxy itself — always private — so checking
 * it alone would let any request the proxy forwards from the internet through.
 * All hops must be private; a forged header can only make the check stricter,
 * because the proxy appends the real peer it saw. Independent of TRUST_PROXY.
 */
export function requestHops(req: Pick<Request, 'socket' | 'headers'>): (string | undefined)[] {
  const hops: (string | undefined)[] = [req.socket.remoteAddress];
  const h = (name: string) => [req.headers[name]].flat().filter((v): v is string => typeof v === 'string');
  for (const v of h('x-forwarded-for')) hops.push(...v.split(',').map(x => x.trim()));
  hops.push(...h('x-real-ip').map(x => x.trim()));
  for (const v of h('forwarded')) {
    for (const m of v.matchAll(/for=("[^"]*"|[^;,\s]+)/gi)) hops.push(forwardedNode(m[1]));
  }
  return hops;
}

export const fromPrivateNetwork = (req: Pick<Request, 'socket' | 'headers'>) => requestHops(req).every(isPrivateAddress);

const available = (t: McpTool) => groupEnabled(t.group);

interface Rpc { jsonrpc?: string; id?: string | number | null; method?: string; params?: any }
const ok = (id: any, result: unknown) => ({ jsonrpc: '2.0', id, result });
const err = (id: any, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const text = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], isError });

/** One JSON-RPC message → its answer, or null for a notification. */
export function handleRpc(msg: Rpc, token: McpToken): object | null {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Ungültige Anfrage');
  if (msg.id === undefined) return null; // notification
  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'dlvault', version: '1' } });
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, {
        tools: TOOLS.filter(available).filter(t => !t.write || token.scope === 'write').map(t => ({
          name: t.name,
          description: t.description + (t.write ? ' (schreibend: confirm=true nötig)' : ''),
          inputSchema: {
            type: 'object',
            properties: { ...t.properties, ...(t.write ? { confirm: { type: 'boolean', description: 'Muss true sein, damit die Änderung ausgeführt wird.' } } : {}) },
            required: [...t.required, ...(t.write ? ['confirm'] : [])],
          },
        })),
      });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === msg.params?.name);
      if (!tool || !available(tool)) return ok(msg.id, text(`Werkzeug „${msg.params?.name}“ ist nicht verfügbar (Funktionsgruppe ${tool ? GROUPS[tool.group].label + ' ausgeschaltet' : 'unbekannt'}).`, true));
      const args = (msg.params?.arguments && typeof msg.params.arguments === 'object') ? msg.params.arguments : {};
      if (tool.write) {
        if (token.scope !== 'write') return ok(msg.id, text('Dieser Zugang darf nur lesen.', true));
        if (args.confirm !== true) return ok(msg.id, text('Nicht ausgeführt: confirm=true fehlt. Erst dem Betreiber sagen, was geändert wird.', true));
      }
      for (const r of tool.required) if (args[r] === undefined) return ok(msg.id, text(`Pflichtangabe fehlt: ${r}`, true));
      try {
        const result = tool.run(args);
        if (tool.write) addLogEntry(null, 'mcp', `${token.name}: ${tool.name} ${JSON.stringify({ ...args, confirm: undefined })}`);
        return ok(msg.id, text(result));
      } catch (e: any) {
        return ok(msg.id, text(e?.message || String(e), true));
      }
    }
    default:
      return err(msg.id, -32601, `Unbekannte Methode: ${msg.method}`);
  }
}

const router = Router();

router.post('/', (req: Request, res: Response) => {
  if (!mcpEnabled()) { res.status(404).json({ error: 'Nicht aktiviert' }); return; }
  if (!fromPrivateNetwork(req)) { res.status(403).json({ error: 'Nur aus privaten Netzen' }); return; }
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const token = m ? verifyToken(m[1]) : null;
  if (!token) { res.status(401).json({ error: 'Token fehlt oder ungültig' }); return; }
  try { touchToken(token.id); } catch (e: any) { logger.debug(`MCP: touch failed: ${e.message}`); }
  const body = req.body;
  if (Array.isArray(body)) {
    const out = body.map(b => handleRpc(b, token)).filter(Boolean);
    if (out.length === 0) { res.status(202).end(); return; }
    res.json(out); return;
  }
  const out = handleRpc(body, token);
  if (!out) { res.status(202).end(); return; }
  res.json(out);
});

router.all('/', (_req, res) => { res.status(405).set('Allow', 'POST').end(); });

export default router;
