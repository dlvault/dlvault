import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The Top 10 parser lives in the plugin bundle (not in this repo). Keep a pin on
// the contract the host relies on: DiscoverItem fields come back per entry.
describe('plugin Top 10 contract', () => {
  it('SearchView reads the same fields the DiscoverItem type defines', () => {
    const view = fs.readFileSync(path.join(__dirname, '../../frontend/src/views/SearchView.vue'), 'utf8');
    for (const f of ['rank', 'title', 'description', 'poster']) expect(view).toContain(f);
    const types = fs.readFileSync(path.join(__dirname, '../../src/plugins/types.ts'), 'utf8');
    for (const f of ['rank: number', 'title: string', 'poster: string | null', 'description: string']) expect(types).toContain(f);
  });
});
