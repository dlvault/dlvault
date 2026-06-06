# Bundled Cloudflare challenge solver. Some sites put their pages behind a
# Cloudflare "managed challenge" that a plain headless browser can't pass; a source
# plugin can delegate the one-time solve to this in-image FlareSolverr
# (source-agnostic — the host stays neutral). Pinned for reproducible builds. Same
# Debian bookworm base as node:22-slim below, so its Python runs here.
FROM ghcr.io/flaresolverr/flaresolverr:v3.5.0 AS flaresolverr

FROM node:22.14-slim AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM node:22.14-slim AS builder

WORKDIR /app

# Install all dependencies (including dev for TypeScript compilation)
COPY package*.json ./
RUN npm ci

# Copy and build backend
COPY src/ ./src/
COPY tsconfig.json ./
RUN npx tsc

# --- Production stage ---
FROM node:22.14-slim

# Xvfb for non-headless Playwright Firefox + gosu to drop privileges from the
# PUID/PGID-aware entrypoint + ffmpeg for the opt-in audio-language check
# (ffprobe reads audio-track language tags). The browser engine (Firefox) and
# its font/system deps are installed below via `playwright install --with-deps firefox`.
#
# chromium + python3/pip + xauth/procps: runtime for the bundled FlareSolverr
# challenge solver (chromium is its browser; apt resolves all of chromium's
# shared-lib deps correctly — copying the binary alone would not).
RUN apt-get update && apt-get install -y \
    xvfb \
    gosu \
    ffmpeg \
    chromium \
    python3 \
    python3-pip \
    xauth \
    procps \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT

# Watchtower picks up containers whose image carries this label. Users who
# run Watchtower alongside dlvault get automatic updates from the registry;
# users who don't are unaffected.
LABEL com.centurylinklabs.watchtower.enable="true"

# OCI metadata — `org.opencontainers.image.source` is the magic label that
# tells ghcr.io which repo this image came from. With this set, future
# pushes inherit the repo's visibility (public repo → public package),
# so users don't have to flip the visibility toggle manually.
LABEL org.opencontainers.image.source="https://github.com/dlvault/dlvault"
LABEL org.opencontainers.image.description="Media-library automation for Plex and Jellyfin."
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Install Playwright Firefox browser + system deps — set cache to shared location
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN npx playwright install --with-deps firefox

# Bundle the FlareSolverr challenge solver: its app code (incl. vendored
# undetected_chromedriver + chromedriver) + its version file (the official image
# keeps package.json at / — FlareSolverr reads it via ../package.json). Its Python
# deps install against Debian's python3 (bookworm → PEP 668 needs the flag).
COPY --from=flaresolverr /app /opt/flaresolverr
COPY --from=flaresolverr /package.json /opt/flaresolverr/package.json
RUN pip3 install --no-cache-dir --break-system-packages -r /opt/flaresolverr/requirements.txt

# Copy built backend + frontend
COPY --from=builder /app/dist ./dist
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist/

# Data and logs directories + Xvfb permissions. The entrypoint adjusts the
# `app` user's UID/GID at runtime to match PUID/PGID (default 99:100 for
# Unraid-friendly ownership), so the build-time UID here is just a placeholder.
RUN mkdir -p /app/data /app/logs /tmp/.X11-unix && \
    chmod 1777 /tmp/.X11-unix && \
    groupadd -r app && useradd -r -g app -d /app app && \
    chown -R app:app /app
VOLUME ["/app/data", "/app/logs"]

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "const http=require('http');const r=http.get('http://localhost:3000/api/health',s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(4000,()=>{r.destroy();process.exit(1)})"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Start Xvfb virtual display + the bundled FlareSolverr solver (internal only,
# 127.0.0.1:8191, auto-restart on crash so a transient chrome death doesn't
# permanently disable challenge solving) + the Node server. Xvfb is shared by
# both browsers (Firefox for plugin link resolution, chromium for FlareSolverr).
#
# FlareSolverr's log is rotated by the wrapper below: winston caps its own files,
# but this one is a plain `>>` append that grew without bound in the
# bind-mounted appdata volume. LOG_LEVEL=warning also drops the per-request
# chatter that made up almost all of that volume.
CMD ["sh", "-c", "rm -f /tmp/.X99-lock && Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &>/dev/null & export DISPLAY=:99 && (cd /opt/flaresolverr && while true; do if [ -f /app/logs/flaresolverr.log ] && [ \"$(stat -c%s /app/logs/flaresolverr.log)\" -gt 10485760 ]; then mv -f /app/logs/flaresolverr.log /app/logs/flaresolverr.log.1; fi; HOST=127.0.0.1 PORT=8191 LOG_LEVEL=${FLARESOLVERR_LOG_LEVEL:-warning} python3 -u flaresolverr.py >>/app/logs/flaresolverr.log 2>&1; sleep 5; done &) && exec node dist/server.js"]
