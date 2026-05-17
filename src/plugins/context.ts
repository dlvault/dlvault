import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { getSetting, setSetting } from '../database/index';
import { logger as rootLogger } from '../utils/logger';
import { QUALITY_RANK, AUDIO_RANK } from '../scraper/constants';
import type { PluginManifest, PluginPermission } from './manifest';

const HTTP_TIMEOUT_MS = 15_000;

export interface PluginHttpResponse<T = unknown> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

/**
 * Convenience HTTP client provided to plugins. Wraps axios with sane defaults
 * (User-Agent, timeout). Plugins are free to bundle their own client too.
 */
export interface PluginHttpClient {
  get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<PluginHttpResponse<T>>;
  post<T = unknown>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<PluginHttpResponse<T>>;
}

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/**
 * Optional capability: get a fresh headless browser. Plugin must close it.
 * Only present on the context if the plugin's manifest declares the `browser`
 * permission. Lazy-loads puppeteer so the host doesn't pay startup cost when
 * no plugin needs a browser.
 */
export interface BrowserFactory {
  launch(): Promise<unknown>;  // returns puppeteer.Browser — typed `unknown` so plugins don't have to bundle @types/puppeteer
}

/**
 * Optional capability: read shared secrets the user has configured. The plugin's
 * manifest declares which secret keys it needs via `requiredSecrets`; the host
 * surfaces them as input fields in the settings UI. Values are stored
 * encrypted and shared across all plugins that requested the same key — by
 * convention plugins namespace their keys (e.g. `"2captcha-api-key"`) to avoid
 * collisions. Returns `''` when the user hasn't configured the secret yet.
 */
export interface PluginSecretsService {
  get(key: string): string;
}

/**
 * Everything a dynamically-loaded plugin gets from the host. The plugin
 * factory receives this object on instantiation.
 *
 * Properties marked optional (browser, secrets) are gated by permissions in
 * the plugin manifest — if the plugin didn't declare them, they're undefined.
 */
export interface PluginContext {
  /** Plugin's own id, for logs and namespacing. */
  pluginId: string;

  // Always-available host APIs:
  logger: PluginLogger;
  http: PluginHttpClient;
  rateLimit(): Promise<void>;

  // Settings — scoped to this plugin's namespace ("plugins.<id>.<key>"):
  getPluginSetting(key: string): string;
  setPluginSetting(key: string, value: string): void;

  // Host constants (shared with scheduler so plugins rank consistently):
  QUALITY_RANK: Readonly<Record<string, number>>;
  AUDIO_RANK: Readonly<Record<string, number>>;

  // Permission-gated:
  browser?: BrowserFactory;
  secrets?: PluginSecretsService;
}

/**
 * Settings-key prefix under which shared plugin secrets live. The settings
 * table treats anything under this prefix as sensitive (encrypted at rest).
 */
export const SECRET_STORE_PREFIX = 'secret-store.';

function buildHttpClient(pluginId: string): PluginHttpClient {
  const headers = { 'User-Agent': `dlvault-plugin/${pluginId}` };
  const wrap = async <T>(req: () => Promise<AxiosResponse<T>>): Promise<PluginHttpResponse<T>> => {
    const res = await req();
    return {
      status: res.status,
      data: res.data,
      headers: Object.fromEntries(
        Object.entries(res.headers).map(([k, v]) => [k, String(v)]),
      ),
    };
  };
  return {
    get: (url, config) => wrap(() => axios.get(url, {
      timeout: HTTP_TIMEOUT_MS,
      ...config,
      headers: { ...headers, ...(config?.headers || {}) },
    })),
    post: (url, body, config) => wrap(() => axios.post(url, body, {
      timeout: HTTP_TIMEOUT_MS,
      ...config,
      headers: { ...headers, ...(config?.headers || {}) },
    })),
  };
}

function buildLogger(pluginId: string): PluginLogger {
  const prefix = `[plugin:${pluginId}]`;
  return {
    info: (m) => rootLogger.info(`${prefix} ${m}`),
    warn: (m) => rootLogger.warn(`${prefix} ${m}`),
    error: (m) => rootLogger.error(`${prefix} ${m}`),
    debug: (m) => rootLogger.debug(`${prefix} ${m}`),
  };
}

// Global rate limiter — shared across all dynamic plugins. Re-uses the existing
// scraper rate-limit window so the host total request rate stays bounded.
import { waitForRateLimit } from '../scraper/rate-limit';

function buildBrowserFactory(pluginId: string): BrowserFactory {
  return {
    async launch() {
      // Lazy-load so non-browser plugins don't pay puppeteer startup.
      const puppeteer = await import('puppeteer');
      rootLogger.debug(`[plugin:${pluginId}] launching browser`);
      return puppeteer.default.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
    },
  };
}

function buildSecretsService(pluginId: string): PluginSecretsService {
  return {
    get(key: string): string {
      // Defence-in-depth: refuse to look up anything that isn't a plausibly
      // shaped secret key. Prevents a plugin from probing `../trakt.client_id`
      // or other unrelated settings via this surface.
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(key)) {
        rootLogger.warn(`[plugin:${pluginId}] secrets.get rejected malformed key "${key}"`);
        return '';
      }
      return getSetting(`${SECRET_STORE_PREFIX}${key}`) || '';
    },
  };
}

/**
 * Build the context object that gets passed to a plugin's factory.
 * Permission-gated capabilities are only attached when the manifest declared them.
 */
export function createPluginContext(manifest: PluginManifest): PluginContext {
  const pluginId = manifest.id;
  const perms = new Set<PluginPermission>(manifest.permissions || []);

  const ctx: PluginContext = {
    pluginId,
    logger: buildLogger(pluginId),
    http: buildHttpClient(pluginId),
    rateLimit: () => waitForRateLimit(),
    getPluginSetting: (key) => getSetting(`plugins.${pluginId}.${key}`),
    setPluginSetting: (key, value) => setSetting(`plugins.${pluginId}.${key}`, value),
    QUALITY_RANK,
    AUDIO_RANK,
  };

  if (perms.has('browser')) {
    ctx.browser = buildBrowserFactory(pluginId);
  }
  if (perms.has('secrets')) {
    ctx.secrets = buildSecretsService(pluginId);
  }

  return Object.freeze(ctx);
}

/** Factory exported by a plugin's default export. */
export type PluginFactory = (context: PluginContext) => import('./types').SourcePlugin;
