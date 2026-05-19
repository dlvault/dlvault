import { Router, Request, Response } from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getSetting } from '../../database/index';
import { getGermanTitleFromWikidata } from '../../services/wikidata';
import { logger } from '../../utils/logger';

const router = Router();

// Sentinel fixture for the Wikidata SPARQL canary. tt0133093 / "Matrix" is
// stable across languages — if the German label changes, our enrichment
// pipeline has bigger problems than this healthcheck.
const SENTINEL_IMDB = 'tt0133093';

interface CheckOutcome {
  ok: boolean;
  critical: boolean;
  detail?: string;
  error?: string;
  // Additional diagnostic fields (balance, path, raw_bytes, etc.)
  [extra: string]: unknown;
}

interface CheckResult extends CheckOutcome {
  latency_ms: number;
}

type CheckFn = () => Promise<CheckOutcome>;

async function timed(fn: CheckFn): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { ...result, latency_ms: Date.now() - t0 };
  } catch (err: any) {
    return {
      ok: false,
      critical: true,
      latency_ms: Date.now() - t0,
      error: err?.message || String(err),
    };
  }
}

/**
 * Wikidata sentinel: resolves the German title for the sentinel IMDb ID.
 * Catches Wikidata outages or schema changes in the SPARQL query.
 */
async function checkWikidata(): Promise<CheckOutcome> {
  const title = await getGermanTitleFromWikidata(SENTINEL_IMDB);
  if (!title) {
    // Non-critical: Wikidata failures degrade search but don't break it
    return { ok: false, critical: false, error: 'Wikidata returned no German title for sentinel' };
  }
  if (!title.toLowerCase().includes('matrix')) {
    return { ok: false, critical: false, error: `Unexpected German title: ${title}` };
  }
  return { ok: true, critical: false, detail: title };
}

/**
 * Filesystem writability: actually creates and deletes a test file in each
 * mount. Catches Unraid permission drift (what happened with Scrubs folder
 * ownership today).
 */
async function checkFsWritable(pathKey: 'paths.downloads' | 'paths.movies' | 'paths.series'): Promise<CheckOutcome> {
  const p = getSetting(pathKey);
  if (!p) {
    return { ok: false, critical: true, error: `${pathKey} not configured` };
  }
  if (!fs.existsSync(p)) {
    return { ok: false, critical: true, error: `Path does not exist: ${p}`, path: p };
  }
  const testFile = path.join(p, `._healthcheck_${process.pid}_${Date.now()}`);
  try {
    fs.writeFileSync(testFile, 'healthcheck');
    const read = fs.readFileSync(testFile, 'utf-8');
    fs.unlinkSync(testFile);
    if (read !== 'healthcheck') {
      return { ok: false, critical: true, error: 'Write succeeded but read mismatch', path: p };
    }
    return { ok: true, critical: true, path: p };
  } catch (err: any) {
    // Clean up if write partially succeeded
    try { fs.unlinkSync(testFile); } catch { /* ignore */ }
    return { ok: false, critical: true, error: err.message, path: p };
  }
}

/**
 * Playwright screenshot sanity: launches a headless Firefox, renders a simple
 * page, takes an element screenshot, and verifies the Buffer → base64
 * conversion produces a non-trivial string.
 *
 * This is the exact code path that broke today's captcha: Playwright-Firefox
 * silently ignores `encoding: 'base64'` on ElementHandle.screenshot() and
 * returns a Buffer. If the library ever switches back to honoring the flag
 * (or to returning an empty buffer for any reason) we find out here instead
 * of on the next captcha attempt.
 */
async function checkPlaywrightScreenshot(): Promise<CheckOutcome> {
  let browser: any = null;
  try {
    // Lazy import so startup isn't slowed by Playwright even when this check
    // isn't being called.
    const { firefox } = await import('playwright-firefox');
    browser = await firefox.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(
      '<div id="target" style="width:100px;height:100px;background:#f00;display:block"></div>',
    );
    const el = await page.$('#target');
    if (!el) {
      return { ok: false, critical: true, error: 'Test element not found after setContent' };
    }
    const raw = await el.screenshot();
    if (!Buffer.isBuffer(raw)) {
      return {
        ok: false,
        critical: true,
        error: `screenshot() returned ${typeof raw}, expected Buffer — Playwright behaviour changed`,
      };
    }
    const b64 = raw.toString('base64');
    if (b64.length < 100) {
      return { ok: false, critical: true, error: `base64 too short (${b64.length} chars) — image likely empty` };
    }
    return {
      ok: true,
      critical: true,
      raw_bytes: raw.length,
      base64_chars: b64.length,
      returns_buffer: true,
    };
  } catch (err: any) {
    return { ok: false, critical: true, error: err.message };
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }
}

/**
 * GET /api/health/deep
 *
 * Expensive canary checks that actually exercise the integrations rather than
 * just reading their config. Intended for post-deploy smoke testing, not
 * continuous polling.
 *
 * Query params:
 *   ?quick=true  — skip Playwright (~4s) and Wikidata (~1s) for faster checks
 */
router.get('/deep', async (req: Request, res: Response) => {
  const started = Date.now();
  const quick = req.query.quick === 'true';

  // Collect every check in parallel so a slow service doesn't block a fast one.
  const checkEntries: Array<[string, Promise<CheckResult>]> = [
    ['fs_downloads', timed(() => checkFsWritable('paths.downloads'))],
    ['fs_movies', timed(() => checkFsWritable('paths.movies'))],
    ['fs_series', timed(() => checkFsWritable('paths.series'))],
  ];
  if (!quick) {
    checkEntries.push(['wikidata', timed(checkWikidata)]);
    checkEntries.push(['playwright_screenshot', timed(checkPlaywrightScreenshot)]);
  }

  const results = await Promise.all(checkEntries.map(async ([name, p]) => [name, await p] as const));
  const checks: Record<string, CheckResult> = Object.fromEntries(results);

  const criticalFailed = Object.values(checks).some(c => !c.ok && c.critical);
  const anyFailed = Object.values(checks).some(c => !c.ok);
  const overall = criticalFailed ? 'unhealthy' : anyFailed ? 'degraded' : 'healthy';

  const payload = {
    overall,
    duration_ms: Date.now() - started,
    version: process.env.GIT_COMMIT || 'dev',
    hostname: os.hostname(),
    quick,
    checks,
  };

  // HTTP status mirrors overall so deploy scripts can `curl --fail`:
  //   healthy → 200, degraded → 200 (still callable), unhealthy → 503
  const status = overall === 'unhealthy' ? 503 : 200;
  res.status(status).json(payload);
});

/**
 * Runs the deep health check internally and returns the payload. Used by the
 * boot-time self-check and the periodic monitor.
 */
export async function runDeepHealthCheck(opts: { quick?: boolean } = {}): Promise<{
  overall: 'healthy' | 'degraded' | 'unhealthy';
  checks: Record<string, CheckResult>;
  duration_ms: number;
}> {
  const started = Date.now();
  const { quick = false } = opts;

  const checkEntries: Array<[string, Promise<CheckResult>]> = [
    ['fs_downloads', timed(() => checkFsWritable('paths.downloads'))],
    ['fs_movies', timed(() => checkFsWritable('paths.movies'))],
    ['fs_series', timed(() => checkFsWritable('paths.series'))],
  ];
  if (!quick) {
    checkEntries.push(['wikidata', timed(checkWikidata)]);
    checkEntries.push(['playwright_screenshot', timed(checkPlaywrightScreenshot)]);
  }

  const results = await Promise.all(checkEntries.map(async ([name, p]) => [name, await p] as const));
  const checks: Record<string, CheckResult> = Object.fromEntries(results);
  const criticalFailed = Object.values(checks).some(c => !c.ok && c.critical);
  const anyFailed = Object.values(checks).some(c => !c.ok);
  const overall = criticalFailed ? 'unhealthy' : anyFailed ? 'degraded' : 'healthy';

  return { overall, checks, duration_ms: Date.now() - started };
}

/**
 * Logs the deep-health payload in a human-readable form for boot-time and
 * periodic check output.
 */
export function logDeepHealth(payload: Awaited<ReturnType<typeof runDeepHealthCheck>>, prefix = 'Health'): void {
  const symbol = payload.overall === 'healthy' ? '✓' : payload.overall === 'degraded' ? '~' : '✗';
  const level = payload.overall === 'unhealthy' ? 'error' : payload.overall === 'degraded' ? 'warn' : 'info';
  logger[level](`${prefix}: ${symbol} ${payload.overall} (${payload.duration_ms}ms)`);
  for (const [name, check] of Object.entries(payload.checks)) {
    const marker = check.ok ? '✓' : check.critical ? '✗' : '~';
    const extra = check.error ? ` — ${check.error}` : check.detail ? ` — ${check.detail}` : '';
    logger[check.ok ? 'info' : check.critical ? 'error' : 'warn'](
      `  ${marker} ${name} (${check.latency_ms}ms)${extra}`,
    );
  }
}

export default router;
