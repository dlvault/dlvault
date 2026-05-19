import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getGermanTitleFromWikidata } from '../../src/services/wikidata';

const binding = (value: string) => ({
  data: { results: { bindings: [{ label: { value } }] } },
});

describe('Wikidata Service — getGermanTitleFromWikidata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.get.mockReset();
  });

  it('returns the German label from the first binding', async () => {
    mockedAxios.get.mockResolvedValueOnce(binding('Matrix'));
    expect(await getGermanTitleFromWikidata('tt0133093')).toBe('Matrix');
  });

  it('returns null when there are no bindings', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { results: { bindings: [] } } });
    expect(await getGermanTitleFromWikidata('tt0000001')).toBeNull();
  });

  it('returns null and swallows network errors', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('SPARQL down'));
    expect(await getGermanTitleFromWikidata('tt0000002')).toBeNull();
  });

  it('caches results and does not re-query for the same imdbId', async () => {
    mockedAxios.get.mockResolvedValueOnce(binding('Cached Titel'));

    expect(await getGermanTitleFromWikidata('tt0000003')).toBe('Cached Titel');
    expect(await getGermanTitleFromWikidata('tt0000003')).toBe('Cached Titel');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('caches negative (null) results too', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('down'));

    expect(await getGermanTitleFromWikidata('tt0000004')).toBeNull();
    expect(await getGermanTitleFromWikidata('tt0000004')).toBeNull();
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('rejects non-canonical imdbIds without querying (SPARQL injection guard)', async () => {
    const malicious = 'tt1" } UNION SELECT ?label WHERE { ?x rdfs:label ?label } #';
    expect(await getGermanTitleFromWikidata(malicious)).toBeNull();
    expect(await getGermanTitleFromWikidata('not-an-id')).toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('passes the imdbId into the SPARQL query', async () => {
    mockedAxios.get.mockResolvedValueOnce(binding('X'));
    await getGermanTitleFromWikidata('tt9999999');

    const [, config] = mockedAxios.get.mock.calls[0];
    expect((config as any).params.query).toContain('tt9999999');
    expect((config as any).params.format).toBe('json');
  });
});
