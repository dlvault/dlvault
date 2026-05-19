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
 * Optional capability: launch a headless browser for plugins that need real
 * page rendering — interactive flows (CAPTCHA, redirects) that a plain HTTP
 * client can't drive. Backed by the host's bundled `playwright-firefox`;
 * Firefox rather than Chromium because some target sites block Chromium.
 *
 * The caller owns the returned browser and MUST `close()` it when done.
 * Requires the `browser` permission.
 */
export interface PluginBrowserService {
  launch(): Promise<import('playwright-firefox').Browser>;
}

/**
 * Everything a dynamically-loaded plugin gets from the host. The plugin
 * factory receives this object on instantiation.
 *
 * Properties marked optional (secrets) are gated by permissions in
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
  secrets?: PluginSecretsService;
  browser?: PluginBrowserService;
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

function buildBrowserService(pluginId: string): PluginBrowserService {
  return {
    async launch() {
      // Dynamic import: playwright-firefox is heavy and only needed by the few
      // plugins that request the `browser` permission. Mirrors the launch used
      // by the host's own health-check screenshot probe.
      const { firefox } = await import('playwright-firefox');
      rootLogger.debug(`[plugin:${pluginId}] launching headless firefox`);
      return firefox.launch({ headless: true });
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
 * Build the context object that gets passed to a plugin's factory. Only the
 * capability permissions (`secrets`, `browser`) attach a corresponding context
 * member — disclosure-only permissions (`filesystem`) intentionally do nothing
 * here, see {@link PluginPermission} for the rationale.
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

  if (perms.has('secrets')) {
    ctx.secrets = buildSecretsService(pluginId);
  }

  if (perms.has('browser')) {
    ctx.browser = buildBrowserService(pluginId);
  }

  return Object.freeze(ctx);
}

/** Factory exported by a plugin's default export. */
export type PluginFactory = (context: PluginContext) => import('./types').SourcePlugin;
