#!/bin/bash
set -e

# PUID/PGID pattern (LinuxServer.io convention). Defaults to 99:100, which
# matches Unraid's `nobody:users` ownership of /mnt/user/appdata/* so a fresh
# install needs no extra env vars. Override via -e PUID=… -e PGID=… on hosts
# where the bind-mounted directories are owned by a different UID/GID.
PUID="${PUID:-99}"
PGID="${PGID:-100}"

# Sync the in-image `app` account to the requested UID/GID. `-o` allows
# duplicate IDs (Unraid's `users` group is already GID 100 inside the image,
# which would otherwise collide). Silenced because the values may match the
# existing ones, in which case the *mod commands no-op-error.
groupmod -o -g "$PGID" app 2>/dev/null || true
usermod  -o -u "$PUID" -g "$PGID" app 2>/dev/null || true

# Bind-mounted volumes show the host's ownership inside the container. Chown
# recursively so files written by a previous image build (with a different
# system UID) remain readable across upgrades. Metadata-only — fast even on
# multi-GB SQLite databases.
chown -R "$PUID:$PGID" /app/data /app/logs 2>/dev/null || true

# Docker socket access — required for the one-click updater to talk to the
# host's dockerd. On Unraid the socket is typically mode 660 root:docker, so
# UID 99 (nobody) can't read it. Detect the socket's group GID and add the
# running `app` user to that group so the in-container process gets access
# without having to run as root.
if [ -S /var/run/docker.sock ]; then
  SOCK_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo '')
  if [ -n "$SOCK_GID" ] && [ "$SOCK_GID" != "$PGID" ]; then
    # Reuse an existing group with that GID if one exists, otherwise make
    # one. This handles every host whether dockerd uses GID 281 (Debian),
    # 999 (CoreOS), or some other arbitrary GID.
    if ! getent group "$SOCK_GID" >/dev/null 2>&1; then
      groupadd -g "$SOCK_GID" dockersock 2>/dev/null || true
    fi
    SOCK_GROUP=$(getent group "$SOCK_GID" 2>/dev/null | cut -d: -f1)
    if [ -n "$SOCK_GROUP" ]; then
      usermod -aG "$SOCK_GROUP" app 2>/dev/null || true
    fi
  fi
fi

exec gosu app "$@"
