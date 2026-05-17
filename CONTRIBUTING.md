# Contributing to dlvault

Thanks for considering a contribution. This document covers what dlvault
accepts and how to get a PR through review.

## What dlvault accepts

- **Core improvements** — scheduler, post-processing, library sync, UI,
  performance, tests, documentation, bug fixes
- **Plugin loader / runtime improvements** — manifest validation, context
  APIs, install flow, audit logging
- **Internet Archive plugin** — the bundled reference plugin
- **Generic helpers for plugin authors** — testing utilities, manifest
  generators, build tooling
- **Documentation** — PLUGIN-AUTHORS.md, examples, deployment guides

## What dlvault does **not** accept

- **Plugins for sources that distribute or facilitate access to copyrighted
  material without authorization.** dlvault is source-neutral by design;
  the core ships only with the public-domain Internet Archive plugin. PRs
  adding plugins for sources that don't respect copyright will be closed
  without merge, regardless of how the plugin is framed.
- **Hardcoded references to specific media sources** (URLs, API paths,
  scraper logic) in the core, scheduler, search routes, post-processor, or
  settings UI. All source-specific code belongs in a plugin.
- **Features whose primary use case is bypassing copyright protections**
  (CAPTCHA bypass scaffolding aimed at specific protected services, DRM
  circumvention helpers, etc.). The generic `context.captcha` API is for
  legitimate captcha gates like rate-limiting forms.

Issues filed about copyright-infringing plugins or sources will be closed
without comment.

---

## Development setup

```bash
git clone https://github.com/dlvault/dlvault
cd dlvault
npm install
cd frontend && npm install && cd ..

# run backend + frontend in parallel
npm run dev:all
```

The setup wizard runs on first start at <http://localhost:3000>.

### Tests

```bash
npm test                # vitest
npx tsc --noEmit        # backend typecheck
cd frontend && npx vue-tsc --noEmit  # frontend typecheck
```

All three must be green before opening a PR.

### Project layout

```
src/                          ← public, AGPL-licensed core
├── api/routes/               REST endpoints
├── database/                 SQLite layer + encryption
├── jdownloader/              JD My-Connect client
├── plugins/
│   ├── types.ts              SourcePlugin interface
│   ├── manifest.ts           PluginManifest + validator
│   ├── context.ts            PluginContext factory
│   ├── registry.ts           In-memory plugin registry
│   ├── loader.ts             Disk-based plugin loader
│   ├── install.ts            Install service (URL / upload / accept)
│   ├── bootstrap.ts          registerBuiltinPlugins()
│   └── internet-archive/     Bundled reference plugin
├── scraper/                  Generic helpers (filter, rate-limit, constants)
├── services/                 Scheduler, post-process, telegram, plex, etc.
├── server.ts                 Express bootstrap
└── utils/

frontend/src/                 ← Vue 3 + Pinia + Vite
├── api/                      API client
├── components/               Reusable components
│   └── settings/             Settings tab components
├── composables/
├── stores/                   Pinia stores
└── views/                    Top-level pages

docs/                         ← Authoring + deployment docs
tests/                        ← Vitest unit/integration tests
data/                         ← Runtime data (DB, logs, plugins) — gitignored
```

---

## Code style

- **TypeScript strict mode** is enabled. Don't disable rules in PRs.
- **No new dependencies** without discussion in an issue first. The project
  intentionally has a small dependency surface.
- **Tests required** for new features and bug fixes. The current bar is
  ~550 tests; please keep it growing.
- **Keep `src/` source-neutral**: source-specific code (URLs, scraper logic,
  API paths) belongs in a plugin under its own repository, not in the core
  tree. The public `src/` must build standalone.
- **Naming**: kebab-case files for new modules, PascalCase Vue components,
  camelCase for variables/functions.

### Commit messages

Conventional-commits-ish. Keep the subject under 70 chars.

```
feat(plugins): add manifest preview endpoint
fix(scheduler): handle plugin throwing in findReleases
docs(authoring): clarify settings schema example
test(loader): cover SHA-mismatch pending case
```

---

## Plugin contributions

Plugins are **separate projects** maintained outside this repo. The
recommended pattern:

- Your plugin repo: `your-account/dlvault-plugin-<id>`
- Build a single `.dlvault.js` bundle (see
  [docs/PLUGIN-AUTHORS.md](docs/PLUGIN-AUTHORS.md))
- Publish releases on GitHub; users install via the raw asset URL

If you want your plugin **mentioned** in the dlvault README or wiki:

- The source it integrates with must be a legitimately operated, copyright-
  respecting service (academic archive, public-domain collection, official
  API of a licensed catalogue, etc.).
- Open an issue with the plugin's repo URL, a description, and confirmation
  of the source's legal status.

We do not maintain a community-curated plugin list — adding your plugin to
documentation requires the maintainers to be comfortable that it doesn't
expose the dlvault project to liability.

---

## Pull request checklist

Before opening a PR:

- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `cd frontend && npx vue-tsc --noEmit` passes
- [ ] New code has tests
- [ ] No new dependencies (or discussed in an issue first)
- [ ] No hardcoded references to specific external media sources in the
      public `src/` tree
- [ ] Commit messages follow the conventional-commits format
- [ ] `README.md` and `docs/` updated if user-facing behavior changed

---

## Reporting bugs

For **core / loader bugs**: open an issue in this repo with steps to
reproduce, the version (`process.env.GIT_COMMIT` or container tag), and
relevant logs from `data/logs/`.

For **plugin-specific bugs**: open the issue in the plugin's own repo —
dlvault maintainers don't triage third-party plugin issues.

For **security issues**: please don't open a public issue. Email or use the
private security-advisory channel on GitHub (`Security` tab → `Report a
vulnerability`).
