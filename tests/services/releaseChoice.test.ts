import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSettings, store, seasonRows } = vi.hoisted(() => ({
  mockSettings: {} as Record<string, string>,
  store: new Map<number, any>(),
  seasonRows: [] as { season_number: number; status: string }[],
}));
vi.mock('../../src/database/index', () => ({ getSetting: (k: string) => mockSettings[k] ?? '' }));
vi.mock('../../src/database/services/releaseChoices', () => ({
  getReleaseChoice: (id: number) => store.get(id) ?? null,
  setReleaseChoice: (id: number, c: any) => { store.set(id, c); },
}));
vi.mock('../../src/database/services/seasons', () => ({ getSeasonsByShowId: () => seasonRows }));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: vi.fn() }));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { promoteByHoster, decideRelease, isWaitingForChoice, CHOICE_TIMEOUT_MS, CHOICE_LATER_MS } from '../../src/services/releaseChoice';
import { addLogEntry } from '../../src/database/services/activityLog';

const rel = (title: string, quality: string, hosters: string[], extra: Record<string, any> = {}) => ({
  title, quality, size: '10 GB', season: null, episode: null, isSeasonPack: false,
  links: hosters.map(h => ({ hoster: h, url: `https://${h}.example/x` })),
  ...extra,
}) as any;
const movie = (over: Record<string, any> = {}) => ({ id: 1, title: 'Grell', media_type: 'movie', season_cutoff: null, ...over }) as any;
const titles = (rs: any[]) => rs.map(r => r.title);
const NOW = 1_000_000_000_000;

beforeEach(() => {
  Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  store.clear();
  seasonRows.length = 0;
  vi.clearAllMocks();
  mockSettings['plugins.src.hosters'] = 'host-b,host-a';
});

describe('promoteByHoster', () => {
  it('moves the best release with the first-choice hoster ahead of a better one without it', () => {
    expect(titles(promoteByHoster([rel('A', '2160p', ['host-c']), rel('B', '1080p', ['host-b'])], 'host-b'))).toEqual(['B', 'A']);
  });

  it('leaves the order alone when the best release has the hoster', () => {
    expect(titles(promoteByHoster([rel('A', '2160p', ['host-b', 'host-c']), rel('B', '1080p', ['host-b'])], 'host-b'))).toEqual(['A', 'B']);
  });

  it('leaves a best release without known links alone', () => {
    expect(titles(promoteByHoster([rel('A', '2160p', []), rel('B', '1080p', ['host-b'])], 'host-b'))).toEqual(['A', 'B']);
  });

  it('works per season pack, not across seasons', () => {
    const p = (t: string, s: number, h: string[]) => rel(t, '1080p', h, { season: s, isSeasonPack: true });
    const out = promoteByHoster([p('S1x', 1, ['host-c']), p('S2x', 2, ['host-c']), p('S1b', 1, ['host-b'])], 'host-b');
    expect(titles(out)).toEqual(['S1b', 'S1x', 'S2x']);
  });
});

describe('decideRelease', () => {
  const swap = () => [rel('A', '2160p', ['host-c']), rel('B', '1080p', ['host-b'])];
  const askOk = vi.fn(async () => true);

  it('changes nothing with both options off', async () => {
    const v = await decideRelease(movie(), swap(), 'src', false, askOk, NOW);
    expect(v).toEqual({ wait: false, releases: swap() });
    expect(askOk).not.toHaveBeenCalled();
  });

  it('applies the hoster rule without asking when only quality.prefer_hoster is on', async () => {
    mockSettings['quality.prefer_hoster'] = 'true';
    const v = await decideRelease(movie(), swap(), 'src', false, askOk, NOW);
    expect(v.wait).toBe(false);
    expect(titles((v as any).releases)).toEqual(['B', 'A']);
  });

  describe('with telegram.release_choice', () => {
    beforeEach(() => { mockSettings['telegram.release_choice'] = 'true'; });

    it('asks in a swap case and waits; the preferred-hoster release is option 1', async () => {
      const ask = vi.fn(async () => true);
      expect(await decideRelease(movie(), swap(), 'src', false, ask, NOW)).toEqual({ wait: true });
      const asked = (ask.mock.calls[0] as any[])[1];
      expect(asked.options.map((o: any) => o.title)).toEqual(['B', 'A']);
      expect(store.get(1).status).toBe('pending');
      expect(addLogEntry).toHaveBeenCalledWith(1, 'choice_asked', expect.any(String));
    });

    it('does not ask when the best release has the first-choice hoster', async () => {
      const v = await decideRelease(movie(), [rel('A', '2160p', ['host-b']), rel('B', '1080p', ['host-c'])], 'src', false, askOk, NOW);
      expect(v.wait).toBe(false);
      expect(askOk).not.toHaveBeenCalled();
    });

    it('keeps waiting within the hour, then falls back to the rule', async () => {
      await decideRelease(movie(), swap(), 'src', false, askOk, NOW);
      expect(await decideRelease(movie(), swap(), 'src', false, askOk, NOW + 30 * 60_000)).toEqual({ wait: true });
      expect(isWaitingForChoice(1, NOW + 30 * 60_000)).toBe(true);
      const v = await decideRelease(movie(), swap(), 'src', false, askOk, NOW + CHOICE_TIMEOUT_MS + 1);
      expect(v.wait).toBe(false);
      expect(titles((v as any).releases)).toEqual(['A', 'B']); // prefer_hoster off → plain quality order
      expect(store.get(1).status).toBe('auto');
      expect(askOk).toHaveBeenCalledTimes(1);
    });

    it('the timeout falls back to the hoster rule when that is on', async () => {
      mockSettings['quality.prefer_hoster'] = 'true';
      await decideRelease(movie(), swap(), 'src', false, askOk, NOW);
      const v = await decideRelease(movie(), swap(), 'src', false, askOk, NOW + CHOICE_TIMEOUT_MS + 1);
      expect(titles((v as any).releases)).toEqual(['B', 'A']);
    });

    it.each([['A', ['A', 'B']], ['B', ['B', 'A']]])('puts the chosen release %s first', async (pick, order) => {
      await decideRelease(movie(), swap(), 'src', false, askOk, NOW);
      store.set(1, { ...store.get(1), status: 'chosen', chosenTitle: pick });
      const v = await decideRelease(movie(), swap(), 'src', false, askOk, NOW + 5_000);
      expect(titles((v as any).releases)).toEqual(order);
    });

    it('"Später" holds for 24 h, then asks again', async () => {
      await decideRelease(movie(), swap(), 'src', false, askOk, NOW);
      store.set(1, { ...store.get(1), status: 'later', at: NOW });
      expect(await decideRelease(movie(), swap(), 'src', false, askOk, NOW + CHOICE_LATER_MS - 1)).toEqual({ wait: true });
      expect(await decideRelease(movie(), swap(), 'src', false, askOk, NOW + CHOICE_LATER_MS + 1)).toEqual({ wait: true });
      expect(askOk).toHaveBeenCalledTimes(2);
    });

    it('applies the rule at once when the question cannot be sent', async () => {
      const v = await decideRelease(movie(), swap(), 'src', false, async () => false, NOW);
      expect(v.wait).toBe(false);
      expect(store.get(1).status).toBe('auto');
    });

    it('asks about a season pack that still needs downloading', async () => {
      const p = (t: string, h: string[]) => rel(t, t === 'A' ? '2160p' : '1080p', h, { season: 1, isSeasonPack: true });
      const ask = vi.fn(async () => true);
      await decideRelease(movie({ media_type: 'show' }), [p('A', ['host-c']), p('B', ['host-b'])], 'src', true, ask, NOW);
      expect((ask.mock.calls[0] as any[])[1].label).toBe('Staffel 1');
    });

    it('does not ask about a season that is already in JD or downloaded', async () => {
      seasonRows.push({ season_number: 1, status: 'downloading' });
      const p = (t: string, h: string[]) => rel(t, '1080p', h, { season: 1, isSeasonPack: true });
      const v = await decideRelease(movie({ media_type: 'show' }), [p('A', ['host-c']), p('B', ['host-b'])], 'src', true, askOk, NOW);
      expect(v.wait).toBe(false);
      expect(askOk).not.toHaveBeenCalled();
    });

    it('isWaitingForChoice is off when the feature is off', () => {
      store.set(1, { status: 'pending', at: NOW });
      delete mockSettings['telegram.release_choice'];
      expect(isWaitingForChoice(1, NOW)).toBe(false);
    });
  });
});
