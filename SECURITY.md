# Security Policy

## Reporting a vulnerability

Please **do not** open public GitHub issues for security vulnerabilities.
Use one of the private channels below so the issue can be fixed before
attackers learn about it.

### Preferred: GitHub Security Advisory

[Open a private security advisory](https://github.com/dlvault/dlvault/security/advisories/new)
on this repository. This is the standard GitHub mechanism — only the
maintainers see the report until publication.

### Scope

In-scope vulnerabilities include, but are not limited to:

- Authentication or authorization bypass
- Remote code execution in the host process
- Plugin loader / installer flaws (a malicious `.dlvault.js` that lands on
  disk or runs **without** the user's explicit disclaimer acceptance, e.g. a
  bypass of the install trust boundary)
- Credential disclosure (API keys, OAuth tokens, JDownloader credentials)
- Path traversal or unintended file-system access
- SQL injection or other injection paths into the SQLite database
- Cross-site scripting in the web UI
- Cross-site request forgery against the API
- Denial-of-service vectors (especially via plugins, since plugins run
  with significant trust)

## Plugin trust model

Read this before reporting plugin-related issues — the trust boundary is
**not** where people often assume it is.

Plugins are ordinary Node.js modules loaded with `require`. Once installed,
a plugin runs **in the host process with full host privileges**: it can
`require('fs')`, `require('child_process')`, open sockets, and read any file
the dlvault process can. **There is no runtime sandbox.**

The `permissions` field in a plugin manifest is **advisory UX**, not an
enforced boundary. It controls only which convenience capabilities the host
*attaches* to the plugin context (e.g. the `browser` and `secrets` helpers) and
what the install UI shows the user. A plugin that does not declare `browser`
can still `require('puppeteer')` itself; declaring fewer permissions does not
sandbox it.

The real trust boundary is **installation**: new code only reaches disk and
runs after the user explicitly accepts the install disclaimer
(`disclaimerAccepted = true`), downloads are HTTPS-only and size-capped, and
each install is recorded with its SHA-256. Installing a plugin is therefore
equivalent to running arbitrary code as the dlvault user — only install
plugins you trust.

When the `API_TOKEN` environment variable is set, the install/upload/accept
routes additionally require that token as a `Bearer` header — the global
auth middleware's browser-bypass does not apply to routes that accept
executable code. Without `API_TOKEN` (the trusted-LAN default), anyone who
can reach the HTTP port can install a plugin; treat network access to
dlvault as equivalent to shell access on the host and set `API_TOKEN` if
that is not acceptable in your deployment.

(Note: the bundled browser helper launches Chromium with `--no-sandbox`, which
is standard for headless Chromium inside a container but is not a security
control.)

Out of scope:

- Third-party plugin **behaviour** — a plugin doing harmful things you
  installed and accepted is the plugin's responsibility, not a host
  vulnerability (there is no sandbox to escape). Report those to the plugin's
  own repository. Flaws in the **install trust boundary itself** (running
  plugin code without disclaimer acceptance, bypassing the HTTPS/size checks)
  are in scope and should be reported here.
- Issues that require physical access to the host machine.
- Issues that require the user to have already given a malicious actor
  full settings-write access.
- Vulnerabilities in dependencies that have already been disclosed
  upstream — please report those to the upstream project.

## Disclosure timeline

- **Acknowledgement:** within 7 days of report
- **Fix or mitigation:** target 30 days for confirmed issues, longer for
  complex changes
- **Public disclosure:** coordinated with the reporter, typically 90 days
  after the fix lands or as soon as a fix is publicly available, whichever
  is sooner

## Supported versions

Only the **latest** release on the `main` branch receives security fixes.
There is no LTS branch. Run the most recent commit if you can.

## What this project does *not* offer

- No bug bounty programme — this is a free, AGPL-licensed project with
  no commercial revenue
- No security guarantees beyond best-effort fixes
- No formal SLA

Good-faith security research is welcome and appreciated.
