import crypto from 'crypto';
import { getSetting, setSetting } from '../database/index';

/**
 * Access tokens for AI clients. Only a SHA-256 hash is stored (setting
 * `mcp.tokens`, a JSON list); the clear token is shown exactly once, when it is
 * created. A token is either read-only or may also write.
 */
export type McpScope = 'read' | 'write';
export interface McpToken { id: string; name: string; hash: string; scope: McpScope; created: string; lastUsed: string | null }

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export function listTokens(): McpToken[] {
  try {
    const v = JSON.parse(getSetting('mcp.tokens') || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function save(tokens: McpToken[]): void {
  setSetting('mcp.tokens', JSON.stringify(tokens));
}

export function createToken(name: string, scope: McpScope): { token: string; entry: Omit<McpToken, 'hash'> } {
  const token = 'dlv_' + crypto.randomBytes(24).toString('hex');
  const entry: McpToken = {
    id: crypto.randomBytes(4).toString('hex'),
    name: String(name || 'KI').slice(0, 60),
    hash: hash(token),
    scope: scope === 'write' ? 'write' : 'read',
    created: new Date().toISOString(),
    lastUsed: null,
  };
  save([...listTokens(), entry]);
  const { hash: _h, ...pub } = entry;
  return { token, entry: pub };
}

export function revokeToken(id: string): boolean {
  const all = listTokens();
  const rest = all.filter(t => t.id !== id);
  if (rest.length === all.length) return false;
  save(rest);
  return true;
}

/** The matching token (constant-time compare), or null. */
export function verifyToken(presented: string): McpToken | null {
  const h = Buffer.from(hash(presented));
  for (const t of listTokens()) {
    const x = Buffer.from(t.hash);
    if (x.length === h.length && crypto.timingSafeEqual(x, h)) return t;
  }
  return null;
}

export function touchToken(id: string): void {
  const all = listTokens();
  const t = all.find(x => x.id === id);
  if (!t) return;
  t.lastUsed = new Date().toISOString();
  save(all);
}
