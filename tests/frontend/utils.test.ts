import { describe, it, expect } from 'vitest';
import { matchByTitle } from '../../frontend/src/utils/titleMatch';
import { isWebUrl } from '../../frontend/src/utils/url';
import { formatLimitKbps, limitMbit, formatAction, ACTION_LABELS } from '../../frontend/src/composables/useFormatters';

type Row = { id: number; title: string; year?: number | null; media_type?: string };
const get = (r: Row) => ({ title: r.title, year: r.year, mediaType: r.media_type });

describe('matchByTitle', () => {
  const rows: Row[] = [
    { id: 1, title: 'Grell', year: 1984, media_type: 'movie' },
    { id: 2, title: 'Grell', year: 2021, media_type: 'movie' },
    { id: 3, title: 'Wardline', year: 2014, media_type: 'show' },
    { id: 4, title: 'Wardline', year: 1996, media_type: 'movie' },
    { id: 5, title: 'Sandmere', year: null, media_type: 'movie' },
  ];

  it('needs the year when the title is ambiguous — a remake must never match the original', () => {
    expect(matchByTitle(rows, get, { title: 'Grell', year: 2021 })?.id).toBe(2);
    expect(matchByTitle(rows, get, { title: 'Grell', year: 1999 })).toBeNull();
    expect(matchByTitle(rows, get, { title: 'Grell' })).toBeNull();
  });

  it('keeps shows and films apart when both sides know the type', () => {
    expect(matchByTitle(rows, get, { title: 'Wardline', year: 2014, mediaType: 'movie' })).toBeNull();
    expect(matchByTitle(rows, get, { title: 'wardline ', year: 2014, mediaType: 'show' })?.id).toBe(3);
  });

  it('accepts a bare title only when exactly one candidate carries it', () => {
    expect(matchByTitle(rows, get, { title: 'Sandmere', year: 2003 })?.id).toBe(5);
    expect(matchByTitle(rows, get, { title: 'Sandmere' })?.id).toBe(5);
    expect(matchByTitle(rows, get, { title: '' })).toBeNull();
  });
});

describe('isWebUrl', () => {
  it('lets only http(s) through — a manifest homepage is untrusted', () => {
    expect(isWebUrl('https://example.com/x')).toBe(true);
    expect(isWebUrl('http://example.com')).toBe(true);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('data:text/html,hi')).toBe(false);
    expect(isWebUrl('not a url')).toBe(false);
    expect(isWebUrl(undefined)).toBe(false);
  });
});

describe('speed limit display', () => {
  it('shows KB/s below 1 MB/s instead of "0 MB/s"', () => {
    expect(formatLimitKbps(300)).toBe('300 KB/s');
    expect(formatLimitKbps(1024)).toBe('1 MB/s');
    expect(formatLimitKbps(5000)).toBe('4,9 MB/s');
    expect(formatLimitKbps(0)).toBe('0 KB/s');
  });

  it('gives the Mbit equivalent with a decimal for small values', () => {
    expect(limitMbit(300)).toBe('2,3');
    expect(limitMbit(10240)).toBe('80');
  });
});

describe('formatAction', () => {
  it('has a German label for the actions the backend writes', () => {
    for (const a of ['import_rejected', 'jd_restarted', 'library_removed', 'source_unreachable', 'seerr_still_looking']) {
      expect(ACTION_LABELS[a], a).toBeTruthy();
      expect(formatAction(a)).not.toContain('_');
    }
  });
});

describe('log action labels stay in step with the backend', () => {
  it('every action passed to addLogEntry has a German label', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const root = path.resolve(__dirname, '../../src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    const missing = new Set<string>();
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/addLogEntry\(\s*[^,]+,\s*'([a-z_]+)'/g)) {
        if (!ACTION_LABELS[m[1]]) missing.add(m[1]);
      }
    }
    expect([...missing]).toEqual([]);
  });
});

describe('JD package names', () => {
  it('undoes JD\'s ":" → ";" rewrite so the package matches its title', async () => {
    const { parsed, packageKey } = await import('../../frontend/src/utils/packageName');
    expect(parsed('Grell; Die Rückkehr (2025) - 1080p')).toEqual({ title: 'Grell: Die Rückkehr', year: 2025 });
    expect(packageKey('Grell; Die Rückkehr (2025) - 1080p')).toBe('Grell: Die Rückkehr (2025)');
    expect(packageKey('Some.Film.2020.1080p')).toBeNull();
  });
});

describe('packageKey for titles without a year', () => {
  it('matches "Title - 1080p" the way dlvault names year-less packages', async () => {
    const { packageKey } = await import('../../frontend/src/utils/packageName');
    expect(packageKey('Quillon - 1080p')).toBe('Quillon');
    expect(packageKey('Quillon - S01 - 1080p')).toBe('Quillon');
    expect(packageKey('Quillon (2024) - 1080p')).toBe('Quillon (2024)');
  });
});

describe('German number and time formats', () => {
  it('uses a decimal comma and one ETA wording', async () => {
    const { formatBytes, formatEta, num } = await import('../../frontend/src/composables/useFormatters');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1,5 GB');
    expect(num(2.25, 2)).toBe('2,25');
    expect(formatEta(290)).toBe('4 Min 50 s');
    expect(formatEta(3900)).toBe('1 Std 5 Min');
    expect(formatEta(12.4)).toBe('12 s');
    expect(formatEta(0)).toBe('–');
  });
});

describe('update dialog errors', () => {
  it('turns updater codes into German sentences', async () => {
    const { updateErrorText } = await import('../../frontend/src/utils/updateErrors');
    expect(updateErrorText('healthcheck_failed')).toContain('Health-Check');
    expect(updateErrorText('unexpected_exit_rc2')).toBe('Updater unerwartet beendet (Code 2)');
    expect(updateErrorText('something_new')).toBe('something new');
  });
});
