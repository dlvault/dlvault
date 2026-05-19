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
# PUID/PGID-aware entrypoint. The browser engine (Firefox) and its font/system
# deps are installed below via `playwright install --with-deps firefox`.
RUN apt-get update && apt-get install -y \
    xvfb \
    gosu \
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

# Start Xvfb virtual display + Node server (Xvfb needed for non-headless Playwright Firefox)
CMD ["sh", "-c", "rm -f /tmp/.X99-lock && Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &>/dev/null & export DISPLAY=:99 && exec node dist/server.js"]
