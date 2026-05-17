#!/bin/bash
# ============================================================
#  dlvault Updater — pull-based
#
#  Runs in a sidecar container with /var/run/docker.sock mounted.
#  Pulls the latest dlvault image from a registry, replaces the
#  running main container with it, health-checks, rolls back on
#  failure.
#
#  Required env:
#    MAIN_CONTAINER   name of the main app container (default: dlvault)
#    IMAGE_NAME       registry image ref               (default: ghcr.io/dlvault/dlvault:latest)
#    STATUS_FILE      where to write progress           (default: /status/update.log)
#  Optional env:
#    HEALTH_PATH      path to probe inside container   (default: /api/health)
#    HEALTH_PORT      port inside container            (default: 3000)
#    REGISTRY_AUTH    base64-encoded `user:token` for private registries
# ============================================================

set -u
set -o pipefail

MAIN_CONTAINER="${MAIN_CONTAINER:-dlvault}"
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/dlvault/dlvault:latest}"
STATUS_FILE="${STATUS_FILE:-/status/update.log}"
HEALTH_PATH="${HEALTH_PATH:-/api/health}"
HEALTH_PORT="${HEALTH_PORT:-3000}"

mkdir -p "$(dirname "$STATUS_FILE")"
: > "$STATUS_FILE"

log()   { printf '%s | %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$STATUS_FILE"; }
phase() { printf '%s | PHASE:%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$STATUS_FILE"; }
fail()  { phase "error:$1"; exit 1; }

trap 'rc=$?; if [ "$rc" -ne 0 ]; then phase "error:unexpected_exit_rc${rc}"; fi' EXIT

probe_health() {
  docker exec "$MAIN_CONTAINER" node -e "
    require('http').get('http://localhost:${HEALTH_PORT}${HEALTH_PATH}', r => process.exit(r.statusCode === 200 ? 0 : 1))
      .on('error', () => process.exit(1));
  " >/dev/null 2>&1
}

# ── 0. Sanity ────────────────────────────────────────────────
phase "starting"
log "Container: $MAIN_CONTAINER · Image: $IMAGE_NAME"

if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  fail "docker_socket_unreachable"
fi

# Capture the currently-running image id BEFORE pulling, so we know what
# to roll back to if the new image health-checks fail.
PREVIOUS_IMAGE_ID=$(docker inspect --format='{{.Image}}' "$MAIN_CONTAINER" 2>/dev/null || echo "")
if [ -n "$PREVIOUS_IMAGE_ID" ]; then
  log "Bisheriges Image: $PREVIOUS_IMAGE_ID"
fi

# ── 1. Login (if a private registry needs it) ────────────────
# Auto-login when REGISTRY_AUTH is set as "user:token-base64". For
# ghcr.io/dlvault/dlvault as a public image, this whole block is a no-op.
if [ -n "${REGISTRY_AUTH:-}" ]; then
  phase "logging_in"
  REGISTRY_HOST="${IMAGE_NAME%%/*}"
  echo "$REGISTRY_AUTH" | base64 -d | docker login "$REGISTRY_HOST" --username "$(echo "$REGISTRY_AUTH" | base64 -d | cut -d: -f1)" --password-stdin >/dev/null 2>&1 \
    || log "Warnung: docker login fehlgeschlagen, versuche public pull"
fi

# ── 2. Pull latest image ─────────────────────────────────────
phase "pulling"
log "Lade neue Version von der Registry..."
if ! docker pull "$IMAGE_NAME" 2>&1 | tee -a "$STATUS_FILE"; then
  fail "pull_failed"
fi

# Did the pull actually change anything?
NEW_IMAGE_ID=$(docker image inspect --format='{{.Id}}' "$IMAGE_NAME" 2>/dev/null || echo "")
if [ -z "$NEW_IMAGE_ID" ]; then
  fail "new_image_inspect_failed"
fi

if [ -n "$PREVIOUS_IMAGE_ID" ] && [ "$PREVIOUS_IMAGE_ID" = "$NEW_IMAGE_ID" ]; then
  log "Bereits auf dem aktuellen Image — nichts zu tun."
  phase "done"
  exit 0
fi

log "Neues Image: $NEW_IMAGE_ID"

# ── 3. Inspect current container to capture run config ───────
phase "inspecting"
if ! INSPECT_JSON=$(docker inspect "$MAIN_CONTAINER" 2>/dev/null); then
  fail "main_container_not_found"
fi

RUN_ARGS=()

RESTART_POLICY=$(echo "$INSPECT_JSON" | jq -r '.[0].HostConfig.RestartPolicy.Name // "unless-stopped"')
[ -n "$RESTART_POLICY" ] && [ "$RESTART_POLICY" != "no" ] && RUN_ARGS+=("--restart" "$RESTART_POLICY")

NET_MODE=$(echo "$INSPECT_JSON" | jq -r '.[0].HostConfig.NetworkMode // ""')
if [ -n "$NET_MODE" ] && [ "$NET_MODE" != "default" ] && [ "$NET_MODE" != "bridge" ]; then
  RUN_ARGS+=("--network" "$NET_MODE")
fi

while IFS=$'\t' read -r host_port container_port; do
  [ -z "$host_port" ] || [ -z "$container_port" ] && continue
  RUN_ARGS+=("-p" "${host_port}:${container_port}")
done < <(echo "$INSPECT_JSON" | jq -r '
  .[0].HostConfig.PortBindings // {} | to_entries[] |
  .key as $cport |
  .value[]? | [.HostPort, $cport] | @tsv
')

while IFS= read -r bind; do
  [ -z "$bind" ] && continue
  RUN_ARGS+=("-v" "$bind")
done < <(echo "$INSPECT_JSON" | jq -r '.[0].HostConfig.Binds // [] | .[]')

while IFS= read -r envvar; do
  [ -z "$envvar" ] && continue
  RUN_ARGS+=("-e" "$envvar")
done < <(echo "$INSPECT_JSON" | jq -r '.[0].Config.Env // [] | .[]')

while IFS= read -r label; do
  [ -z "$label" ] && continue
  RUN_ARGS+=("--label" "$label")
done < <(echo "$INSPECT_JSON" | jq -r '.[0].Config.Labels // {} | to_entries[] | "\(.key)=\(.value)"')

log "Run-Args erfasst: ${#RUN_ARGS[@]} Einträge"

# ── 4. Stop and replace old container ────────────────────────
phase "restarting"
docker stop "$MAIN_CONTAINER" 2>&1 | tee -a "$STATUS_FILE" || log "Warnung: stop fehlgeschlagen"
docker rm "$MAIN_CONTAINER"   2>&1 | tee -a "$STATUS_FILE" || log "Warnung: rm fehlgeschlagen"

if ! docker run -d --name "$MAIN_CONTAINER" "${RUN_ARGS[@]}" "$IMAGE_NAME" 2>&1 | tee -a "$STATUS_FILE"; then
  log "Neuer Container konnte nicht gestartet werden — Rollback..."
  phase "rollback"
  if [ -n "$PREVIOUS_IMAGE_ID" ]; then
    docker run -d --name "$MAIN_CONTAINER" "${RUN_ARGS[@]}" "$PREVIOUS_IMAGE_ID" 2>&1 | tee -a "$STATUS_FILE" || true
  fi
  fail "container_start_failed"
fi

# ── 5. Health check ──────────────────────────────────────────
phase "health"
log "Warte auf Health-Check (docker exec → localhost:${HEALTH_PORT}${HEALTH_PATH})..."
HEALTHY=0
for i in $(seq 1 30); do
  if probe_health; then
    HEALTHY=1
    log "Health-Check OK nach ${i}s"
    break
  fi
  sleep 1
done

if [ "$HEALTHY" -ne 1 ]; then
  log "Health-Check fehlgeschlagen nach 30s — Rollback..."
  phase "rollback"
  docker stop "$MAIN_CONTAINER" 2>&1 | tee -a "$STATUS_FILE" || true
  docker rm   "$MAIN_CONTAINER" 2>&1 | tee -a "$STATUS_FILE" || true
  if [ -n "$PREVIOUS_IMAGE_ID" ]; then
    docker run -d --name "$MAIN_CONTAINER" "${RUN_ARGS[@]}" "$PREVIOUS_IMAGE_ID" 2>&1 | tee -a "$STATUS_FILE" || true
  fi
  fail "healthcheck_failed"
fi

phase "done"
log "Update erfolgreich"
trap - EXIT
exit 0
