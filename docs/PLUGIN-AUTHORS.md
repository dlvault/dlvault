# Writing a dlvault Plugin

dlvault is a media-library orchestrator: it watches a Trakt/Plex watchlist,
fetches metadata, hands downloads to JDownloader, and keeps the library tidy.
The actual "where does this title come from" question is answered by
**plugins** — small JavaScript files that implement a defined interface.

This document is the contract between dlvault and a plugin author.

> **Plugin authors are solely responsible for their plugin's content and the
> use it enables.** dlvault provides the loader and the runtime — it does
> not host, curate, endorse, or recommend any plugin. Your plugin must
> comply with all applicable copyright, licensing, and terms-of-service
> agreements of the sources it integrates with.

---

## 1. What a plugin looks like

A plugin is **a single JavaScript file** ending in `.dlvault.js`. It exports:

- a **`manifest`** (named export) — declarative metadata
- a **default factory function** — receives a context, returns the plugin

```js
// my-source.dlvault.js
module.exports.manifest = {
  id: 'my-source',
  name: 'My Source',
  version: '1.0.0',
  mediaTypes: ['movie'],
  description: 'Public-domain films from example.org',
  author: 'Your Name',
  homepage: 'https://github.com/you/dlvault-plugin-my-source',
  cspDomains: ['example.org'],
};

module.exports.default = function createPlugin(context) {
  const { http, logger } = context;
  return {
    id: 'my-source',
    name: 'My Source',
    mediaTypes: ['movie'],

    async findReleases(query) {
      const res = await http.get('https://example.org/api/search', {
        params: { q: query.title, year: query.year },
      });
      // …turn API rows into ScrapedRelease objects…
      return { sourceUrl: 'https://example.org/details', releases };
    },

    async resolveLinks(links) {
      return links;  // already direct URLs → no-op
    },
  };
};
```

That's it — no `package.json`, no `node_modules`. If your plugin needs an
external library, bundle it with `esbuild` into the single file (see § 7).

---

## 2. How a plugin is installed

There are three install paths, all of which trigger the same disclaimer +
audit flow:

1. **URL install** — user pastes `https://…/your-plugin.dlvault.js` into the
   "Plugin hinzufügen" dialog → dlvault downloads, validates, shows a
   manifest preview, requires explicit acceptance.
2. **File upload** — user picks the file from their computer → same preview
   and acceptance flow.
3. **Drop-file** — user copies the file directly into `data/plugins/` via
   SFTP/SMB → it appears in the "Wartet auf Bestätigung" list with a manifest
   preview and an "Akzeptieren" button.

In all paths, dlvault writes an entry to `data/plugins/disclaimer-log.json`
recording: plugin id, manifest version, file SHA-256, source URL (if any),
acceptance timestamp. **Plugins are not loaded until that entry exists** —
the audit trail is the trust boundary.

---

## 3. Manifest reference

```ts
interface PluginManifest {
  id: string;                  // kebab-case, used in setting keys
  name: string;                // human-readable, shown in UI
  version: string;             // semver (e.g. "1.2.3")
  mediaTypes: ('movie' | 'show')[];

  description?: string;        // shown in install preview
  author?: string;
  homepage?: string;           // your GitHub repo or info page

  cspDomains?: string[];       // host names you need for poster <img> etc.
  minHostVersion?: string;     // e.g. "^1.0.0"
  permissions?: ('browser' | 'secrets' | 'filesystem')[];

  settingsSchema?: {
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'secret' | 'multi-select';
    options?: string[];      // required when type === 'multi-select'
    default?: string;        // for multi-select, a comma-joined subset of options
    description?: string;
  }[];

  // Shared secrets — surfaced in the host's "Plugin Secrets" settings tab.
  // Aggregated across all installed plugins; same `key` in two plugins means
  // both read the same user-configured value. Requires the `secrets` permission.
  requiredSecrets?: {
    key: string;               // kebab-case, namespaced (`<service>-<purpose>`)
    label: string;
    description?: string;
  }[];
}
```

`multi-select` renders as chip-checkboxes; the value is stored as a
comma-separated string and you read it back via
`context.getPluginSetting(key).split(',').filter(Boolean)`.

### Permissions

Permissions are opt-in capabilities. If you don't declare a permission, the
corresponding context member is `undefined`. The user sees the permission
list in the install dialog before accepting.

| Permission   | What it unlocks                                                        | When to request                          |
|--------------|------------------------------------------------------------------------|------------------------------------------|
| `browser`    | `context.browser.launch()` — headless Puppeteer browser                | Source page requires JavaScript to render |
| `secrets`    | `context.secrets.get(key)` — user-configured shared API keys / tokens  | Plugin needs an external service credential (an API key, OAuth token, etc.) |
| `filesystem` | Permission to read/write outside the plugin sandbox (e.g. `os.tmpdir()`) | Bundled-worker pattern (see § 7.2) or any other local file I/O |

Request the smallest set you actually need.

### Settings schema

If your plugin needs runtime configuration (regional preference, hoster
priority, etc.), declare it as `settingsSchema`. dlvault renders the matching
form under the plugin's entry in the settings UI. Read/write via
`context.getPluginSetting(key)` / `context.setPluginSetting(key, value)`.
All keys are automatically namespaced under `plugins.<your-id>.<key>` —
you can't collide with another plugin or the core.

For **API keys, tokens, or other credentials**, use `requiredSecrets` instead
of `settingsSchema` — see the next subsection.

### Required secrets (shared credentials)

External services (captcha solvers, premium hoster accounts, paid APIs)
typically need a user-supplied credential. Declaring them as `requiredSecrets`
gives you four things over a per-plugin `settingsSchema` entry:

1. **Shared by key.** Two plugins that both declare `"2captcha-api-key"` see
   the same user-configured value — the user enters it once.
2. **Encrypted at rest.** Values stored under `secret-store.*` in the
   settings table are AES-encrypted with the host's local key.
3. **Aggregated UI.** All requested secrets from all installed plugins
   appear together in the host's "Plugin Secrets" settings tab, each with
   the requesting-plugin name shown.
4. **Namespace hygiene.** The host validates keys are kebab-case
   (`a-z`, `0-9`, `-`) and the plugin's `secrets.get()` rejects anything
   else — you can't accidentally request `../trakt.client_id`.

Example manifest:

```js
manifest.permissions = ['secrets'];
manifest.requiredSecrets = [
  {
    key: '2captcha-api-key',
    label: '2Captcha API key',
    description: 'Used by plugins that solve captchas via 2captcha.com.',
  },
];
```

Read it at runtime:

```js
const apiKey = context.secrets.get('2captcha-api-key');
// → empty string if user hasn't configured it yet
```

**Naming convention**: prefix the key with the service name to avoid
collisions across unrelated plugins. `2captcha-api-key`, `tmdb-bearer-token`,
`deepl-api-key`, etc. Two plugins targeting the same service share the
secret; plugins targeting different services don't conflict.

---

## 4. PluginContext API reference

The factory receives a frozen `PluginContext` with everything the plugin
needs from the host. **Use these APIs instead of importing equivalents
directly** — that's what makes plugins portable across dlvault versions and
keeps them testable with a mock context.

```ts
interface PluginContext {
  pluginId: string;

  // Logging — scoped to your plugin, integrates with host log file
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
  };

  // HTTP — convenience wrapper around axios with User-Agent + timeout
  http: {
    get<T>(url: string, config?: AxiosRequestConfig): Promise<{ status, data: T, headers }>;
    post<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<…>;
  };

  // Settings — namespaced to plugins.<your-id>.*
  getPluginSetting(key: string): string;
  setPluginSetting(key: string, value: string): void;

  // Rate limiting — shared with the host's other plugins
  rateLimit(): Promise<void>;

  // Constants — host's ranking tables (so plugins rank consistently)
  QUALITY_RANK: Readonly<Record<string, number>>;
  AUDIO_RANK: Readonly<Record<string, number>>;

  // Permission-gated capabilities (undefined unless declared in manifest):
  browser?: { launch(): Promise<puppeteer.Browser> };
  secrets?: {
    /**
     * Read a user-configured shared secret by key. Returns '' when the user
     * hasn't configured the secret yet. The host validates the key shape
     * (kebab-case) and refuses anything else, so this can't be used to
     * probe arbitrary settings.
     */
    get(key: string): string;
  };
}
```

### Reading credentials with `secrets`

The host stores shared credentials (API keys, OAuth tokens, premium-account
passwords, …) in an encrypted-at-rest secret store. Plugins declare what
they need via `manifest.requiredSecrets` (see § 3) and read the values at
runtime:

```js
const apiKey = context.secrets.get('2captcha-api-key');
if (!apiKey) {
  context.logger.warn('user has not configured 2captcha-api-key');
  return [];
}
// …use apiKey to call an external service, hand it to a forked worker, etc.
```

Two plugins requesting the same key share the value — there's only one
"2Captcha API key" the user enters, regardless of how many plugins use it.
By convention the key prefixes itself with the service name
(`2captcha-api-key`, `tmdb-bearer-token`, `deepl-api-key`, etc.) to keep
namespaces clean.

---

## 5. SourcePlugin interface

Your factory returns an object that conforms to `SourcePlugin`:

```ts
interface SourcePlugin {
  // Identity (must match manifest)
  readonly id: string;
  readonly name: string;
  readonly mediaTypes: readonly ('movie' | 'show')[];
  readonly cspDomains?: readonly string[];

  // REQUIRED: find releases for a search query
  findReleases(query: SearchQuery, opts?: { skipLinkResolution?: boolean }): Promise<ReleaseSet>;

  // REQUIRED: turn redirect/container URLs into direct hoster URLs.
  // No-op for sources that always return direct links.
  resolveLinks(links: HosterLink[]): Promise<HosterLink[]>;

  // OPTIONAL: short title-suggestion list for disambiguation UIs
  searchTitles?(query: string, opts?: { mediaType?, limit? }): Promise<TitleCandidate[]>;

  // OPTIONAL: featured / trending list surfaced by host UIs
  discover?(mediaType: 'movie' | 'show'): Promise<DiscoverItem[]>;
  getCachedDiscover?(mediaType: 'movie' | 'show'): DiscoverItem[] | null;

  // OPTIONAL: liveness check surfaced in /api/health/deep
  healthCheck?(): Promise<{ ok: boolean, critical: boolean, detail?, error? }>;

  // OPTIONAL: cleanup on shutdown (close browsers, sockets, etc.)
  close?(): Promise<void>;
}
```

### Return shapes

```ts
interface SearchQuery {
  title: string;
  year?: number;
  imdbId?: string;
  mediaType: 'movie' | 'show';
  altTitle?: string;        // localized title when known
}

interface ReleaseSet {
  sourceUrl: string | null; // canonical detail page, shown as "Quelle öffnen"
  releases: ScrapedRelease[];
}

interface ScrapedRelease {
  title: string;
  quality: string;          // '2160p' | '1080p' | '720p' | '480p' | 'unknown'
  audio: string;            // common values: '7.1' | '5.1' | 'atmos' | 'dts' | '2.0' — or 'unknown'
  language: string;         // ISO 639-1 code (e.g. 'en', 'de', 'es') — or 'unknown'
  size: string;             // e.g. "8.4 GB"
  releaseType: string;      // common values: 'remux' | 'complete' | 'rip' — or 'unknown'
  isDolbyVision: boolean;
  season: number | null;
  episode: number | null;
  isSeasonPack: boolean;    // true for season releases without an episode number
  links: { hoster: string; url: string }[];
}
```

The host filters releases by user-configured quality/audio rules before
acting on them — you don't need to apply user preferences yourself.

### Defensive plugin design

Sources lie. Search APIs return junk. User-uploaded content gets mislabeled
to capture clicks. Your plugin is the trust boundary between the upstream
source and dlvault's library — defending it is your job.

Common attack patterns plugins should defend against:

- **Title-spam uploads.** On open archives (archive.org, etc.) anyone can
  upload an item titled to match a new release. Mitigation: restrict
  searches to **curated collections** the source exposes. For Internet
  Archive that's `collection:feature_films` (kuratiert) vs.
  `opensource_movies` (the default user-upload bucket — full of junk).
- **Year-field gaming.** Spammers sometimes tag their junk uploads with
  the year of the legitimate release they're impersonating. A year match
  alone is not enough. Combine with collection + creator-whitelist or
  cross-check IMDb-ID where the source exposes it.
- **File-size masquerading.** A 2 GB MP4 looks like a real movie but can
  contain anything. If the source supports checksums (md5/sha1) and you
  know a legitimate hash, prefer that as the integrity signal over file
  size or title.
- **Multiple matches.** When the source returns multiple candidates,
  prefer the one with the most populated metadata (description, IMDb-ID,
  release year set in metadata not just the search index). Empty/sparse
  metadata is a red flag.

The bundled Internet Archive plugin demonstrates the curated-collection
pattern: `findReleases` and `searchTitles` both pass `collection: 'feature_films'`
so that random `opensource_movies` uploads can't match. Read
`src/plugins/internet-archive/index.ts` for the full filter chain.

---

## 6. Distribution

You distribute the `.dlvault.js` file however you want. Recommended:

- **GitHub release** with the bundled file as an asset. Users paste the
  asset's raw URL into the install dialog.
- **Static host** (your own server, S3, …). HTTPS is required.

dlvault itself **does not provide a plugin registry, marketplace, or
discovery feature** — by design. Plugin authors are responsible for
distribution; users are responsible for choosing what to install.

Versioning: bump `manifest.version` on every release. Users see the version
in the install preview and in the installed-plugins list. Updates work by
re-installing — dlvault overwrites the file and updates the disclaimer
entry's SHA hash.

---

## 7. Building

For a **simple plugin** with no external dependencies, no build step is
needed. Write CommonJS-style (`module.exports = …`), save as
`my-plugin.dlvault.js`, distribute.

For a plugin that needs **external libraries**, bundle with [esbuild](https://esbuild.github.io/):

```bash
esbuild src/index.js \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --outfile=my-plugin.dlvault.js \
  --external:axios       # Don't bundle axios — use context.http instead
```

Mark `axios`, `puppeteer`, and other host-provided libraries as `--external`
so the bundle stays small and uses the host's versions. Anything truly
plugin-specific (HTML parser, special-purpose library) gets bundled in.

Hard limits enforced by the loader:
- **Maximum file size: 5 MB**
- File **must end in `.dlvault.js`**
- Must export both `manifest` (named) and `default` (function)

### 7.1 What to bundle vs. mark external

Host-provided libraries should be marked `--external:<name>` so your bundle
doesn't ship a duplicate copy:

| Library            | Why external                                                   |
|--------------------|----------------------------------------------------------------|
| `axios`            | Use `context.http` instead — your bundle shouldn't even reach for it |
| `puppeteer`        | Use `context.browser.launch()`; the host owns the binary       |
| `playwright-firefox` | Provided by the host's Docker image (gated by `filesystem` + fork pattern below) |

Bundle in everything else your plugin needs (HTML parser, decrypt routines,
small utility libraries).

### 7.2 Bundled workers (forking a separate process)

Some sources block the Node event loop in ways that can't be cleanly bailed
out of in-process — long-running browser sessions, native captcha clients,
etc. A common pattern: ship a **worker script** that runs in its own
process, and SIGKILL it from the parent on timeout.

Since plugins are a single `.dlvault.js` file, the worker has to be
**embedded** inside it. The build pipeline:

```js
// build.mjs
import { build } from 'esbuild';
import fs from 'fs';

// 1. Bundle the worker as a standalone CJS module.
await build({
  entryPoints: ['src/worker.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/_worker.bundle.js',
  external: ['playwright-firefox'],   // or whatever native dep the worker uses
});

// 2. Embed the worker bundle as a base64 string in the main plugin bundle
//    via a `define` constant.
const workerB64 = fs.readFileSync('dist/_worker.bundle.js').toString('base64');

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/my-plugin.dlvault.js',
  define: { '__WORKER_B64__': JSON.stringify(workerB64) },
});

fs.unlinkSync('dist/_worker.bundle.js');
```

In the parent code, `__WORKER_B64__` is replaced at build time with the
literal base64 string. At runtime, the plugin materializes the worker to
`os.tmpdir()` once per process and forks it:

```ts
declare const __WORKER_B64__: string;

let cachedWorkerPath: string | null = null;
function ensureWorkerOnDisk(ctx: PluginContext): string {
  if (cachedWorkerPath && fs.existsSync(cachedWorkerPath)) return cachedWorkerPath;
  const code = Buffer.from(__WORKER_B64__, 'base64').toString('utf-8');
  const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 12);
  const target = path.join(os.tmpdir(), `my-plugin-worker-${hash}.js`);
  if (!fs.existsSync(target)) fs.writeFileSync(target, code, { mode: 0o600 });
  cachedWorkerPath = target;
  return target;
}
```

**Two non-obvious gotchas** with this pattern:

1. **`NODE_PATH` for the forked child.** The worker lives in `os.tmpdir()`,
   so its default module resolution can't find the host's `node_modules`.
   If the worker `require()`s a host-provided native module
   (`playwright-firefox`, `better-sqlite3`, etc.), the parent must locate the
   host's `node_modules` and pass it via `NODE_PATH`:

   ```ts
   const candidates = [
     path.join(process.cwd(), 'node_modules'),
     '/app/node_modules',           // dlvault Docker WORKDIR
     '/usr/src/app/node_modules',   // alternative layouts
   ];
   // Walk up from __dirname as a last-resort fallback. Pick the first
   // candidate that has the specific package you need installed.
   const hostNodeModules = candidates.find(p => fs.existsSync(
     path.join(p, 'playwright-firefox', 'package.json'),
   ));

   const worker = fork(workerPath, [], {
     stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
     env: { ...process.env, NODE_PATH: hostNodeModules },
   });
   ```

2. **`require.resolve()` is unreliable inside plugins.** When the host
   installs a plugin via the upload API, the file is loaded from a temp
   install directory whose require root has no `node_modules` above it.
   `require.resolve('playwright-firefox')` will throw `MODULE_NOT_FOUND`
   even though the package is installed. Always use the walk-up fallback
   pattern above instead of trusting `require.resolve()`.

The `filesystem` permission is what gates the `os.tmpdir()` write —
declare it in your manifest if you use this pattern.

---

## 8. Testing

The recommended test pattern: mock the `PluginContext`, call your factory,
exercise the returned plugin. No need to mock `axios` or any library — just
the host APIs your plugin uses.

```js
import { describe, it, expect, vi } from 'vitest';
import factory, { manifest } from './my-plugin';

function makeMockContext(overrides = {}) {
  return {
    pluginId: manifest.id,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    http: {
      get: vi.fn().mockResolvedValue({ status: 200, data: {}, headers: {} }),
      post: vi.fn().mockResolvedValue({ status: 200, data: {}, headers: {} }),
    },
    rateLimit: vi.fn().mockResolvedValue(undefined),
    getPluginSetting: vi.fn(() => ''),
    setPluginSetting: vi.fn(),
    QUALITY_RANK: { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 },
    AUDIO_RANK: { 'atmos': 4, '7.1': 4, '5.1': 3, '2.0': 1 },
    // Only attach permission-gated members if your manifest declares them:
    browser: { launch: vi.fn().mockResolvedValue({ close: vi.fn() }) },
    secrets: {
      get: vi.fn((key: string) => key === '2captcha-api-key' ? 'mock-key' : ''),
    },
    ...overrides,
  };
}

describe('my-plugin', () => {
  it('searches and returns releases', async () => {
    const ctx = makeMockContext();
    ctx.http.get.mockResolvedValueOnce({
      status: 200, headers: {}, data: { /* fake API response */ },
    });
    const plugin = factory(ctx);
    const result = await plugin.findReleases({ title: 'foo', mediaType: 'movie' });
    expect(result.releases).toHaveLength(/* … */);
  });
});
```

`tests/plugins/internet-archive.test.ts` in the dlvault repo is the full
reference — copy it as a starting point.

---

## 9. Source-specific gotchas

A non-exhaustive list of things that have bitten real plugins. Worth a read
before you spend hours staring at "why doesn't this work in headless".

### 9.1 Sites with ad pre-landers

Some sources route their click-through URLs through an interstitial ad
network before the real destination. In a normal browser, the ad page runs
a `setTimeout` after a few seconds and redirects on its own. Headless
plugins commonly fail this in two ways:

- **Aggressive request interception** that blocks images/CSS/fonts. The ad
  page's redirect script often *depends* on those resources loading
  (analytics fires, CSS-driven progress bar finishes, etc.). With them
  blocked, the redirect never fires. **For pages that may be ad pre-landers,
  let the page load fully — do not call `setRequestInterception(true)`.**
- **Short waits.** Don't `await new Promise(r => setTimeout(r, 3000))` and
  give up. Use `page.waitForFunction(() => /destination-pattern/.test(window.location.href), { timeout: 15000, polling: 500 })` —
  it returns as soon as the redirect happens, and only times out if the ad
  never resolves.

### 9.2 Open-archive title spam

On open archives (archive.org `opensource_movies`, similar buckets on other
sites) anyone can upload an item with a title matching a new theatrical
release to harvest clicks. Mitigations, in rough order of effectiveness:

1. **Restrict to curated collections** the source exposes. For Internet
   Archive: `collection:feature_films` (kuratiert) vs. the default
   `opensource_movies` (a junk bucket). Same idea applies to other
   community-driven archives.
2. **IMDb-ID cross-check.** If the source captures IMDb-ID in metadata,
   only accept matches where it's set and equal. Title+year alone is too
   weak.
3. **Year-strict matching.** A spammer who copies the year of a real
   release will match a naive year filter. Cross-check at least two of:
   year + curated-collection + IMDb-ID + populated description.

### 9.3 Search-API rate limits

Many source APIs aggressively rate-limit or shadow-ban repeated requests
from the same IP. Always `await context.rateLimit()` before each outbound
call to a source — that's the shared host-wide window and keeps all
plugins polite together. Don't roll your own rate limiter on top.

### 9.4 PluginHttpResponse doesn't expose `request`

`context.http` returns `{ status, data, headers }` — a deliberate subset of
axios's response object. If you need to inspect the final URL after a
redirect chain, you cannot read `response.request.res.responseUrl` (it's
not on the wrapper). Use `context.browser.launch()` and read `page.url()`
instead, or set `maxRedirects: 0` and follow the `Location` header yourself.

---

## 10. Reference implementation

The bundled **Internet Archive** plugin is the canonical example of a
well-formed plugin. Read it in full:

- `src/plugins/internet-archive/index.ts` — manifest + factory
- `src/plugins/internet-archive/api.ts` — context-driven API client
- `tests/plugins/internet-archive.test.ts` — test pattern

It demonstrates every part of the contract: manifest, factory, all optional
methods (`searchTitles`, `discover`, `healthCheck`), and a clean test that
runs entirely against a mock context.

---

## 11. Legal & responsibility

To be explicit:

- **dlvault is a generic orchestrator.** It does not endorse, host, or
  curate any plugin. The plugin loader treats every plugin as untrusted code
  until the user explicitly accepts the install disclaimer.
- **Plugin authors retain all responsibility** for their plugin's content,
  for the legality of accessing the integrated source, and for compliance
  with the source's terms of service.
- **Plugin users are responsible** for choosing which plugins to install
  and for using them within their local jurisdiction's laws.
- The disclaimer that users accept at install time is recorded with the
  plugin id, file hash, timestamp, and (for URL installs) the source URL.
  This audit log is local to the user's instance.

Plugins for sources that **distribute or facilitate access to copyrighted
material without authorization** MUST NOT include `dlvault` in the plugin
name, repo name, package identifier, or any user-facing attribution. Such
plugins should be distributed under an identity unrelated to the dlvault
maintainers or to the author's other publicly-attributable open-source work.
The plugin architecture is intentionally agnostic — it doesn't prevent
such plugins from existing — but their authors and users take on the
corresponding legal risk.

### Licensing — plugins are independent works

dlvault itself is licensed under **AGPL-3.0-or-later**. That license covers
the dlvault core (this repository) and the bundled Internet Archive plugin.
It does **not** cover third-party plugins distributed as `.dlvault.js`
files.

A plugin is an **independent work**, not a derivative of dlvault. Concretely:

- It's distributed as a **separate file** from the dlvault core, typically
  in its own repository under its own version control.
- It's **loaded dynamically at runtime** via Node's CommonJS `require()` —
  no compile-time linking, no shared build process, no static dependency.
- All `import type` references to the dlvault types are **type-only and
  stripped at bundle time** — the runtime `.dlvault.js` has zero
  compile-time linkage to the host.
- It communicates with the core **exclusively through the documented
  `PluginContext` boundary** — no shared globals, no monkey-patching, no
  reach-through into core internals.

This places plugins in the category the FSF describes as "aggregation"
rather than "derivative work" (see the
[GNU GPL FAQ entry on plugins](https://www.gnu.org/licenses/gpl-faq.html#GPLAndPlugins)).
Therefore:

- **Plugin authors may license their plugin under any license they choose,**
  including proprietary, commercial, or another open-source license. The
  plugin's license does not propagate into the dlvault core, and dlvault's
  AGPL does not propagate into the plugin.
- This is the same legal structure that WordPress plugins, GIMP scripts,
  VLC extensions, and similar systems rely on. Established practice.

The technical boundary is deliberately strict (single-file `.dlvault.js`,
context-injection only) precisely to make this separation unambiguous.
**Plugin authors should preserve that boundary**: don't reach into dlvault
internals via filesystem inspection of the host repo, runtime monkey-
patching of host globals, or similar techniques. Doing so weakens the
"independent work" argument and could expose your plugin to AGPL viral
effect.

---

## Questions?

- Open an issue at the dlvault repo **only for plugin loader bugs or
  manifest contract questions**. Keep issues generic — describe the bug
  in terms of the loader or contract, not in terms of a specific
  third-party source or its content.
- For **plugin-specific issues**, open them at the plugin's own repo.
  Issues opened at the dlvault repo that name, describe, or reference
  specific third-party plugins or their source sites will be closed
  without response — dlvault maintainers do not triage third-party
  plugin bugs.
