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
- Plugin loader escapes (a malicious `.dlvault.js` reading data outside
  its declared permissions, escalating to host-level access, etc.)
- Credential disclosure (API keys, OAuth tokens, JDownloader credentials)
- Path traversal or unintended file-system access
- SQL injection or other injection paths into the SQLite database
- Cross-site scripting in the web UI
- Cross-site request forgery against the API
- Denial-of-service vectors (especially via plugins, since plugins run
  with significant trust)

Out of scope:

- Third-party plugin bugs — please report those to the plugin's own
  repository. Bugs **in the plugin loader itself** (allowing a malicious
  plugin to escape its sandbox) are in scope and should be reported here.
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
