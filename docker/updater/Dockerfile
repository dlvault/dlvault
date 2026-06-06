FROM alpine:3.20

# Tiny sidecar — pull + restart only. No git / build chain anymore since the
# pull-based update flow doesn't need them.
RUN apk add --no-cache \
    bash \
    docker-cli \
    jq \
    coreutils

COPY update.sh /usr/local/bin/update.sh
RUN chmod +x /usr/local/bin/update.sh

# OCI metadata — links the package to its source repo so ghcr.io can
# inherit the repo's public/private visibility for new package versions.
LABEL org.opencontainers.image.source="https://github.com/dlvault/dlvault"
LABEL org.opencontainers.image.description="Sidecar updater for dlvault — pulls the latest image and restarts the main container."
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENTRYPOINT ["/usr/local/bin/update.sh"]
