import { describe, it, expect, vi, beforeEach } from 'vitest';

const st = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  tags: null as string[] | null,
  seconds: null as number | null,
  tracks: null as { language: string; channels: number }[] | null,
  runtimeRejects: 0,
}));
vi.mock('../../src/database/index', () => ({ getSetting: (k: string) => st.settings[k] ?? '' }));
vi.mock('../../src/database/services/blocklist', () => ({ countBlocklistedWithReason: () => st.runtimeRejects }));
vi.mock('../../src/utils/ffprobe', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/ffprobe')>()),
  audioLanguageTags: async () => st.tags,
  mediaDurationSeconds: async () => st.seconds,
  audioTracks: async () => st.tracks,
  lastVideoPacketSeconds: async () => (st as any).lastPacket ?? null,
  lastVideoPacketSecondsFullScan: async () => (st as any).fullLast ?? (st as any).lastPacket ?? null,
}));

import { runtimeVerdict, languageVerdict, channelsVerdict, verifyMovieImport } from '../../src/services/importCheck';
import { parseAudioTracksJson } from '../../src/utils/ffprobe';

const film = { id: 1, runtime: 100, media_type: 'movie' } as any;

describe('runtimeVerdict', () => {
  it('accepts the normal spread around the stated runtime', () => {
    expect(runtimeVerdict(95 * 60, 100).ok).toBe(true);
    expect(runtimeVerdict(105 * 60, 100).ok).toBe(true);
  });

  it('rejects a file a third longer — the wrong-film signature', () => {
    const v = runtimeVerdict(134 * 60, 100, 'Grell.2026.German.DL.1080p.WEB');
    expect(v.ok).toBe(false);
    expect(!v.ok && v.detail).toBe('134 min statt 100 min');
  });

  it('rejects a truncated file', () => {
    expect(runtimeVerdict(60 * 60, 100).ok).toBe(false);
  });

  it('allows longer cuts when the release says so', () => {
    expect(runtimeVerdict(140 * 60, 100, 'Grell.2026.EXTENDED.German.DL.1080p').ok).toBe(true);
    expect(runtimeVerdict(140 * 60, 100, "Grell.2026.Directors.Cut.German.1080p").ok).toBe(true);
  });

  it('does not judge implausible metadata', () => {
    // A feature film listed with "2 min" must not reject every release.
    expect(runtimeVerdict(84 * 60, 2).ok).toBe(true);
    expect(runtimeVerdict(84 * 60, null).ok).toBe(true);
  });
});

describe('languageVerdict', () => {
  it('rejects tagged audio without the wanted language, accepts untagged', () => {
    expect(languageVerdict(['eng'], 'german').ok).toBe(false);
    expect(languageVerdict(['ger', 'eng'], 'german').ok).toBe(true);
    expect(languageVerdict([], 'german').ok).toBe(true);
    expect(languageVerdict(null, 'german').ok).toBe(true);
  });
});

describe('verifyMovieImport', () => {
  beforeEach(() => {
    st.settings = { 'quality.language': 'german' };
    st.tags = null; st.seconds = null; st.tracks = null; st.runtimeRejects = 0;
  });

  it('checks language only in strict mode or for an upgrade', async () => {
    st.tags = ['eng'];
    expect((await verifyMovieImport(film, 'f.mkv', 'r')).ok).toBe(true);
    expect((await verifyMovieImport(film, 'f.mkv', 'r', { isUpgrade: true })).ok).toBe(false);
    st.settings['quality.language_strict'] = 'true';
    expect((await verifyMovieImport(film, 'f.mkv', 'r')).ok).toBe(false);
  });

  it('checks runtime, but stops after two runtime rejections for the title', async () => {
    st.seconds = 134 * 60;
    expect((await verifyMovieImport(film, 'f.mkv', 'r')).ok).toBe(false);
    st.runtimeRejects = 2;   // the metadata is the likelier culprit now
    expect((await verifyMovieImport(film, 'f.mkv', 'r')).ok).toBe(true);
  });

  it('can be switched off', async () => {
    st.seconds = 134 * 60;
    st.settings['integrity.verify_import'] = 'false';
    expect((await verifyMovieImport(film, 'f.mkv', 'r')).ok).toBe(true);
  });

  it('cannot judge without ffprobe', async () => {
    expect((await verifyMovieImport(film, 'f.mkv', 'r')).ok).toBe(true);
  });
});

describe('audio channels against the configured minimum', () => {
  const t = (language: string, channels: number) => ({ language, channels });

  it('passes the best track in the wanted language when it reaches the minimum', () => {
    expect(channelsVerdict([t('eng', 6), t('ger', 6)], 'german', '5.1').ok).toBe(true);
    expect(channelsVerdict([t('ger', 2), t('ger', 8)], 'german', '7.1').ok).toBe(true);
  });

  it('rejects a German stereo track under a 5.1 minimum, even when the English one is 5.1', () => {
    const v = channelsVerdict([t('eng', 6), t('ger', 2)], 'german', '5.1');
    expect(v.ok).toBe(false);
    expect(!v.ok && v.detail).toBe('Stereo statt mind. 5.1');
  });

  it('cannot judge without information and lets it pass', () => {
    expect(channelsVerdict(null, 'german', '5.1').ok).toBe(true);
    expect(channelsVerdict([t('', 2)], 'german', '5.1').ok).toBe(true);     // untagged
    expect(channelsVerdict([t('ger', 0)], 'german', '5.1').ok).toBe(true);  // no channel info
    expect(channelsVerdict([t('ger', 2)], 'german', '').ok).toBe(true);     // no minimum set
  });

  it('parses ffprobe output', () => {
    expect(parseAudioTracksJson('{"streams":[{"channels":6,"tags":{"language":"GER"}},{"channels":2}]}'))
      .toEqual([t('ger', 6), t('', 2)]);
    expect(parseAudioTracksJson('garbage')).toEqual([]);
  });

  it('refuses a stereo film at import with a 5.1 minimum, but not a series episode', async () => {
    st.settings['quality.audio_minimum'] = '5.1';
    st.tracks = [t('ger', 2)];
    const film = await verifyMovieImport({ id: 1, runtime: 100, media_type: 'movie' }, '/x.mkv', 'Grell.2024.German.AAC.1080p');
    expect(film.ok).toBe(false);
    expect(!film.ok && film.kind).toBe('channels');
    const ep = await verifyMovieImport({ id: 2, runtime: 45, media_type: 'show' }, '/x.mkv', 'Grell.S01E01');
    expect(ep.ok).toBe(true);
  });
});

describe('truncationVerdict', () => {
  it('flags a file whose last frame is far before its header length', async () => {
    const { truncationVerdict } = await import('../../src/services/importCheck');
    const v = truncationVerdict(2826, 733);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toBe('Datei bricht nach 12 von 47 Minuten ab');
  });
  it('allows trailing credits without video and cannot judge without data', async () => {
    const { truncationVerdict } = await import('../../src/services/importCheck');
    expect(truncationVerdict(2895, 2800).ok).toBe(true);
    expect(truncationVerdict(2895, null).ok).toBe(true);
    expect(truncationVerdict(null, 10).ok).toBe(true);
    expect(truncationVerdict(120, 10).ok).toBe(true);   // short clips are not judged
  });
});

describe('parseLastPacketTime', () => {
  it('takes the last number, ignoring blanks and stray lines', async () => {
    const { parseLastPacketTime } = await import('../../src/utils/ffprobe');
    expect(parseLastPacketTime('1.0\n2.5\n\n733.983000\n')).toBe(733.983);
    expect(parseLastPacketTime('')).toBeNull();
  });
});

describe('checkTruncation', () => {
  it('rejects a settled cut-off file but only postpones one that is still being written', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { checkTruncation } = await import('../../src/services/importCheck');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trunc-')), 'Wardline (2018).mkv');
    fs.writeFileSync(f, 'x');
    (st as any).seconds = 4589; (st as any).lastPacket = 673;
    const fresh = await checkTruncation(f);
    expect(fresh.ok).toBe(false);
    expect(!fresh.ok && fresh.retryLater).toBe(true);        // extraction may still be running
    const later = await checkTruncation(f, Date.now() + 11 * 60 * 1000);
    expect(!later.ok && later.retryLater).toBeFalsy();       // settled: a real cut
    (st as any).fullLast = 4580;                             // the full read disagrees: seek misled
    expect((await checkTruncation(f, Date.now() + 11 * 60 * 1000)).ok).toBe(true);
    (st as any).fullLast = undefined;
    (st as any).lastPacket = 4570;
    expect((await checkTruncation(f)).ok).toBe(true);
    (st as any).lastPacket = undefined;
  });
});
