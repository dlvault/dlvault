import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mocks must be set up before importing the module under test ─────────────

const { mockAxiosGet } = vi.hoisted(() => ({ mockAxiosGet: vi.fn() }));
vi.mock('axios', () => ({ default: { get: mockAxiosGet, post: vi.fn() } }));

const mockSettings: Record<string, string> = {};
vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  setSetting: vi.fn(),
  default: { prepare: vi.fn() },
}));

const mockGermanTitle = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/wikidata', () => ({
  getGermanTitleFromWikidata: mockGermanTitle,
}));

// Stub fs so we don't poke the real filesystem in tests
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => 'healthcheck'),
  unlinkSync: vi.fn(),
}));
vi.mock('fs', () => ({ default: mockFs, ...mockFs }));

// Playwright is the most expensive check — stub it out with a known-good reply
// so we don't launch a real browser in unit tests.
const mockFirefoxLaunch = vi.hoisted(() => vi.fn());
vi.mock('playwright-firefox', () => ({
  firefox: { launch: mockFirefoxLaunch },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────
import healthRoutes, { runDeepHealthCheck } from '../../src/api/routes/health';

function makeApp() {
  const app = express();
  app.use('/api/health', healthRoutes);
  return app;
}

function setupHappyPath() {
  Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
  mockSettings['paths.downloads'] = '/downloads';
  mockSettings['paths.movies'] = '/movies';
  mockSettings['paths.series'] = '/series';
  mockSettings['secret-store.2captcha-api-key'] = 'test-key';

  mockGermanTitle.mockResolvedValue('Matrix');
  mockAxiosGet.mockResolvedValue({ data: { status: 1, request: '12.34' } });
  mockFs.existsSync.mockReturnValue(true);
  mockFs.writeFileSync.mockImplementation(() => undefined);
  mockFs.readFileSync.mockReturnValue('healthcheck');
  mockFs.unlinkSync.mockImplementation(() => undefined);

  // Minimal Playwright double: returns a 200-byte Buffer from screenshot().
  const el = { screenshot: vi.fn().mockResolvedValue(Buffer.alloc(200, 0xAB)) };
  const page = {
    setContent: vi.fn().mockResolvedValue(undefined),
    $: vi.fn().mockResolvedValue(el),
  };
  const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
  mockFirefoxLaunch.mockResolvedValue(browser);
}

describe('GET /api/health/deep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
  });

  it('returns 200 healthy when all checks pass', async () => {
    const res = await request(makeApp()).get('/api/health/deep');
    expect(res.status).toBe(200);
    expect(res.body.overall).toBe('healthy');
    expect(res.body.checks.playwright_screenshot.ok).toBe(true);
    expect(res.body.checks.fs_downloads.ok).toBe(true);
  });

  it('returns 503 unhealthy when a filesystem path is not writable', async () => {
    mockFs.writeFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });
    const res = await request(makeApp()).get('/api/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.overall).toBe('unhealthy');
    // At least one fs check failed
    const fsChecks = ['fs_downloads', 'fs_movies', 'fs_series'];
    const failedFs = fsChecks.filter(k => !res.body.checks[k].ok);
    expect(failedFs.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 503 unhealthy when Playwright screenshot returns a non-Buffer', async () => {
    const el = { screenshot: vi.fn().mockResolvedValue('not-a-buffer') };
    const page = { setContent: vi.fn(), $: vi.fn().mockResolvedValue(el) };
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn() };
    mockFirefoxLaunch.mockResolvedValue(browser);

    const res = await request(makeApp()).get('/api/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.playwright_screenshot.ok).toBe(false);
    expect(res.body.checks.playwright_screenshot.error).toMatch(/Playwright behaviour changed/i);
  });

  it('skips Playwright and Wikidata when quick=true', async () => {
    const res = await request(makeApp()).get('/api/health/deep?quick=true');
    expect(res.status).toBe(200);
    expect(res.body.quick).toBe(true);
    expect(res.body.checks).not.toHaveProperty('playwright_screenshot');
    expect(res.body.checks).not.toHaveProperty('wikidata');
    expect(res.body.checks).toHaveProperty('fs_downloads');
    expect(mockFirefoxLaunch).not.toHaveBeenCalled();
  });

  it('reports each check`s latency', async () => {
    const res = await request(makeApp()).get('/api/health/deep');
    for (const [, check] of Object.entries(res.body.checks as Record<string, any>)) {
      expect(typeof check.latency_ms).toBe('number');
      expect(check.latency_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('catches thrown errors inside a check and marks it failed', async () => {
    mockFirefoxLaunch.mockRejectedValueOnce(new Error('Firefox executable missing'));
    const res = await request(makeApp()).get('/api/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.playwright_screenshot.ok).toBe(false);
    expect(res.body.checks.playwright_screenshot.error).toContain('Firefox executable missing');
  });
});

describe('runDeepHealthCheck (internal helper)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
  });

  it('returns the same shape as the HTTP endpoint', async () => {
    const result = await runDeepHealthCheck();
    expect(result).toHaveProperty('overall');
    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('duration_ms');
    expect(['healthy', 'degraded', 'unhealthy']).toContain(result.overall);
  });

  it('honours the quick option', async () => {
    const result = await runDeepHealthCheck({ quick: true });
    expect(result.checks).not.toHaveProperty('playwright_screenshot');
    expect(result.checks).not.toHaveProperty('wikidata');
  });
});
