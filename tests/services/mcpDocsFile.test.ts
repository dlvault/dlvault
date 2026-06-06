import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../src/database/index', () => ({ getSetting: () => '', setSetting: vi.fn(), default: {} }));
vi.mock('../../src/database/services/movies', () => ({}));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: vi.fn() }));
vi.mock('../../src/services/problems', () => ({ collectProblems: () => [] }));

import { toolDocs } from '../../src/mcp/docs';

// docs/MCP-TOOLS.md is generated from the tool registry. If this fails, regenerate it:
//   UPDATE_MCP_DOCS=1 npx vitest run tests/services/mcpDocsFile.test.ts
describe('docs/MCP-TOOLS.md', () => {
  it('matches the tool registry', () => {
    const file = path.join(__dirname, '../../docs/MCP-TOOLS.md');
    if (process.env.UPDATE_MCP_DOCS) fs.writeFileSync(file, toolDocs() + '\n');
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(toolDocs().trim());
  });
});
