import { GROUPS, TOOLS } from './tools';

/** Markdown listing of every tool, generated from the registry (never written by hand). */
export function toolDocs(): string {
  const lines = ['# dlvault MCP — Werkzeuge', '', 'Erzeugt aus der Werkzeug-Liste; nicht von Hand ändern.', ''];
  for (const [id, g] of Object.entries(GROUPS)) {
    lines.push(`## ${g.label} (\`${id}\`)`, '', g.description, '');
    for (const t of TOOLS.filter(x => x.group === id)) {
      const args = Object.entries(t.properties).map(([k, p]) => `\`${k}\` (${p.type}${t.required.includes(k) ? ', Pflicht' : ''}) — ${p.description}`);
      lines.push(`- **${t.name}**${t.write ? ' ✎ schreibt, braucht `confirm: true`' : ''} — ${t.description}${args.length ? '\n  - ' + args.join('\n  - ') : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
