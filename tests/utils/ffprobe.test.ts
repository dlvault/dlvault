import { describe, it, expect } from 'vitest';
import {
  wantedLanguageCodes,
  audioMatchesLanguage,
  parseAudioLanguageJson,
} from '../../src/utils/ffprobe';

describe('ffprobe — wantedLanguageCodes', () => {
  it('maps german to all common ISO variants', () => {
    expect(wantedLanguageCodes('german')).toEqual(expect.arrayContaining(['ger', 'deu', 'de']));
  });

  it('is case-insensitive and trims', () => {
    expect(wantedLanguageCodes('  German ')).toEqual(expect.arrayContaining(['ger', 'deu']));
  });

  it('falls back to literal + prefixes for an unmapped language', () => {
    const codes = wantedLanguageCodes('portuguese');
    expect(codes).toContain('portuguese');
    expect(codes).toContain('po');
    expect(codes).toContain('por');
  });
});

describe('ffprobe — audioMatchesLanguage', () => {
  it('matches a 639-2/B tag (ger) for wanted german', () => {
    expect(audioMatchesLanguage(['ger', 'eng'], 'german')).toBe(true);
  });

  it('matches a 639-1 tag (de)', () => {
    expect(audioMatchesLanguage(['de'], 'german')).toBe(true);
  });

  it('does not match an english-only track set for wanted german', () => {
    expect(audioMatchesLanguage(['eng', 'en'], 'german')).toBe(false);
  });

  it('does not match an empty tag list', () => {
    expect(audioMatchesLanguage([], 'german')).toBe(false);
  });
});

describe('ffprobe — parseAudioLanguageJson', () => {
  it('extracts lowercased language tags from audio streams', () => {
    const out = JSON.stringify({
      streams: [{ tags: { language: 'GER' } }, { tags: { language: 'eng' } }],
    });
    expect(parseAudioLanguageJson(out)).toEqual(['ger', 'eng']);
  });

  it('drops und/unknown and empty tags (no signal)', () => {
    const out = JSON.stringify({
      streams: [{ tags: { language: 'und' } }, { tags: {} }, { tags: { language: 'ger' } }],
    });
    expect(parseAudioLanguageJson(out)).toEqual(['ger']);
  });

  it('returns [] for streams with no tags at all', () => {
    expect(parseAudioLanguageJson(JSON.stringify({ streams: [{}, {}] }))).toEqual([]);
  });

  it('returns [] for malformed JSON', () => {
    expect(parseAudioLanguageJson('not json')).toEqual([]);
  });

  it('returns [] when there are no streams', () => {
    expect(parseAudioLanguageJson(JSON.stringify({}))).toEqual([]);
  });
});
