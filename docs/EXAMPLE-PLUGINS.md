# Example plugins

dlvault is a plugin host — the core ships with no built-in sources. The
setup wizard offers to install the official reference plugin below; the
rest of this page lists legitimate source types that fit dlvault's
architecture, as a starting point for plugin authors.

---

## Official reference plugin

### Internet Archive — public-domain feature films

- **Repo:** [github.com/dlvault/plugin-archive-org](https://github.com/dlvault/plugin-archive-org)
- **Source:** [archive.org's `feature_films` collection](https://archive.org/details/feature_films)
- **License:** AGPL-3.0
- **Content:** ~6,000 public-domain titles — *Night of the Living Dead*,
  *Nosferatu*, *His Girl Friday*, government educational reels, the
  Prelinger archive, etc.
- **How it works:** searches archive.org's metadata API, returns direct
  download links. No captcha, no rate limiting, no authentication.
- **Why it's the reference:** small (~8 KB bundled), demonstrates the
  manifest + factory pattern, and the source is unambiguously legal.

Install via the setup wizard's first step, or paste the release URL
into **Settings → Plugins**:

```
https://github.com/dlvault/plugin-archive-org/releases/latest/download/internet-archive.dlvault.js
```

---

## Legitimate source types for plugin authors

These are categories of sources that fit dlvault's architecture and
that we'd be comfortable mentioning on this page if someone writes a
plugin. Not endorsements — vet each source yourself.

### Public-domain & openly-licensed video

- **archive.org Audio** — Live Music Archive (CC-licensed concerts),
  78 RPM and cylinder collections (public-domain), Old Time Radio.
- **NASA Image and Video Library** — NASA-produced footage is generally
  public domain in the US (`images.nasa.gov`).
- **Vimeo Creative Commons** — CC-licensed video via Vimeo's API
  (filter by license).
- **Wikimedia Commons** — CC / public-domain media.
- **Library of Congress** — Free-to-Use sets (historic film, audio).
- **Smithsonian Open Access** — millions of items released CC0.

### Openly-licensed audio

- **Free Music Archive** — CC-licensed music catalog.
- **Jamendo** — artist-uploaded CC music with a free-listening API.
- **ccMixter** — CC-licensed remixes and originals.
- **Musopen** — public-domain classical recordings + scores.
- **BBC Sound Effects** — released under the BBC Sound Effects Personal
  Use Licence.

### Audiobooks & spoken word

- **LibriVox** — public-domain audiobooks, volunteer-recorded.
- **Open Culture audiobook directory** — curated public-domain readings.

---

## Plugin author criteria

If you're considering writing a plugin and want it listed here, the
source needs to meet the following:

1. **Clearly legal at time of listing.** Public-domain content,
   explicit CC/open licensing, or an official API of a licensed
   catalogue (institutional archive, university press, government
   agency).
2. **Stable, documented API.** Plugins that scrape unstable HTML or
   that violate a ToS aren't appropriate here.
3. **Plugin lives in its own repo** under your account. dlvault doesn't
   host third-party plugin code.
4. **AGPL-compatible license** for the plugin code (so it stays
   compatible with dlvault's runtime).

Open an issue on the dlvault repo with the plugin's repo URL and a
short description of the source's legal status. We don't curate a
discovery UI inside dlvault itself — this page is the only place we
mention third-party plugins, and only when we've reviewed them.

---

## What we won't list

We won't list plugins for sources where the legitimacy depends on the
user's specific use case ("for backup of files you already own", etc.),
where the legal posture relies on jurisdictional grey areas, or where
the primary use case is bypassing access controls or copy protection.
See [CONTRIBUTING.md](../CONTRIBUTING.md#what-dlvault-does-not-accept)
for the full list.
