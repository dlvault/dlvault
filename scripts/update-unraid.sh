#!/bin/bash
# ============================================================
#  dlvault — Unraid Update Script
#  Usage: bash /mnt/user/appdata/dlvault/scripts/update-unraid.sh
# ============================================================

set -e

REPO_DIR="/mnt/user/appdata/dlvault"
DATA_DIR="${REPO_DIR}/data"
CONTAINER_NAME="dlvault"
IMAGE_NAME="dlvault:latest"
UPDATER_IMAGE="dlvault-updater:latest"
TEMPLATE="/boot/config/plugins/dockerMan/templates-user/my-dlvault.xml"

# Source optional .env (lets users keep GITHUB_TOKEN out of the shell history).
if [ -z "${GITHUB_TOKEN:-}" ] && [ -f "${REPO_DIR}/.env" ]; then
  # shellcheck disable=SC1090
  set -a; . "${REPO_DIR}/.env"; set +a
fi

# Colors
G='\033[0;32m'  # green
Y='\033[1;33m'  # yellow
R='\033[0;31m'  # red
B='\033[1m'     # bold
N='\033[0m'     # reset

info()  { echo -e "${Y}[$(date +%H:%M:%S)]${N} $1"; }
ok()    { echo -e "${G}[$(date +%H:%M:%S)] ✓${N} $1"; }
fail()  { echo -e "${R}[$(date +%H:%M:%S)] ✗${N} $1"; exit 1; }

echo -e "\n${B}${G}=== dlvault Update ===${N}\n"

# ── 1. Pull latest code ──────────────────────────────────────
info "Code aktualisieren..."
cd "$REPO_DIR" || fail "Repo-Verzeichnis $REPO_DIR nicht gefunden"
OLD_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

GIT_FETCH_ARGS=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  GIT_FETCH_ARGS+=(-c "http.extraheader=AUTHORIZATION: bearer ${GITHUB_TOKEN}")
fi

git "${GIT_FETCH_ARGS[@]}" fetch origin 2>/dev/null || fail "git fetch fehlgeschlagen (privates Repo - GITHUB_TOKEN gesetzt?)"
git reset --hard origin/main 2>/dev/null || fail "git reset fehlgeschlagen"
git clean -fdx --exclude=data/ --exclude=logs/ 2>/dev/null || true
NEW_HASH=$(git rev-parse --short HEAD)

if [ "$OLD_HASH" = "$NEW_HASH" ]; then
  ok "Bereits auf dem neuesten Stand ($NEW_HASH)"
  echo -e "\nKein Update noetig. Container laeuft schon mit der aktuellen Version."
  exit 0
fi

echo -e "  ${OLD_HASH} → ${B}${NEW_HASH}${N}"

# ── 2. Build new image ───────────────────────────────────────
info "Neues Docker-Image bauen (das dauert ein paar Minuten)..."
docker build --build-arg "GIT_COMMIT=$NEW_HASH" -t "$IMAGE_NAME" "$REPO_DIR" || fail "Docker build fehlgeschlagen"
ok "Image gebaut: $IMAGE_NAME ($NEW_HASH)"

# ── 2b. Build/refresh updater image (for One-Click-Update from WebUI) ──
if [ -d "${REPO_DIR}/docker/updater" ]; then
  info "Updater-Image bauen/aktualisieren..."
  if docker build -t "$UPDATER_IMAGE" "${REPO_DIR}/docker/updater" >/dev/null 2>&1; then
    ok "Updater-Image bereit: $UPDATER_IMAGE"
  else
    info "Updater-Image-Build fehlgeschlagen — One-Click-Update bleibt evtl. inaktiv"
  fi
fi

# ── 3. Stop and remove old container ─────────────────────────
info "Container stoppen..."
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

# ── 4. Recreate container from Unraid template ───────────────
info "Container aus Unraid-Template neu erstellen..."

if [ ! -f "$TEMPLATE" ]; then
  # Fallback: no template found, use docker run with basic config
  info "Kein Unraid-Template gefunden — verwende Standard-Konfiguration"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -p 3000:3000 \
    -e NODE_ENV=production \
    -e PORT=3000 \
    -e "HOST_REPO_DIR=${REPO_DIR}" \
    -e "HOST_DATA_DIR=${DATA_DIR}" \
    -e "MAIN_CONTAINER=${CONTAINER_NAME}" \
    -e "MAIN_IMAGE=${IMAGE_NAME}" \
    -e "UPDATER_IMAGE=${UPDATER_IMAGE}" \
    ${GITHUB_TOKEN:+-e "GITHUB_TOKEN=${GITHUB_TOKEN}"} \
    -v "${DATA_DIR}:/app/data" \
    -v /mnt/user/appdata/dlvault/logs:/app/logs \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /mnt/user/Downloads:/downloads \
    -v /mnt/user/Mediathek/Filme:/movies \
    -v /mnt/user/Mediathek/Serien:/series \
    "$IMAGE_NAME" || fail "Container-Start fehlgeschlagen"
else
  # Parse Unraid XML template and build docker run command
  RUN_ARGS=()
  RUN_ARGS+=("--name" "$CONTAINER_NAME")
  RUN_ARGS+=("--restart" "unless-stopped")

  # Network
  NETWORK=$(sed -n 's|.*<Network>\(.*\)</Network>.*|\1|p' "$TEMPLATE")
  [ -n "$NETWORK" ] && RUN_ARGS+=("--net=$NETWORK")

  # Labels for Unraid Docker management
  WEBUI=$(sed -n 's|.*<WebUI>\(.*\)</WebUI>.*|\1|p' "$TEMPLATE")
  OVERVIEW=$(sed -n 's|.*<Overview>\(.*\)</Overview>.*|\1|p' "$TEMPLATE")
  ICON=$(sed -n 's|.*<Icon>\(.*\)</Icon>.*|\1|p' "$TEMPLATE")

  RUN_ARGS+=("--label" "net.unraid.docker.managed=dockerman")
  [ -n "$WEBUI" ] && RUN_ARGS+=("--label" "net.unraid.docker.webui=$WEBUI")
  [ -n "$ICON" ] && RUN_ARGS+=("--label" "net.unraid.docker.icon=$ICON")

  # Parse Config entries from template
  while IFS= read -r line; do
    TYPE=$(echo "$line" | sed -n 's/.*Type="\([^"]*\)".*/\1/p')
    TARGET=$(echo "$line" | sed -n 's/.*Target="\([^"]*\)".*/\1/p')
    MODE=$(echo "$line" | sed -n 's/.*Mode="\([^"]*\)".*/\1/p')
    VALUE=$(echo "$line" | sed -n 's|.*>\(.*\)</Config>|\1|p')

    [ -z "$VALUE" ] || [ -z "$TARGET" ] && continue

    case "$TYPE" in
      Port)
        RUN_ARGS+=("-p" "$VALUE:$TARGET/$MODE")
        ;;
      Path)
        if [ -n "$MODE" ]; then
          RUN_ARGS+=("-v" "$VALUE:$TARGET:$MODE")
        else
          RUN_ARGS+=("-v" "$VALUE:$TARGET")
        fi
        ;;
      Variable)
        RUN_ARGS+=("-e" "$TARGET=$VALUE")
        ;;
    esac
  done < <(grep '<Config ' "$TEMPLATE")

  # Always append the One-Click-Update wiring, even if the Unraid template
  # doesn't include them yet — so the WebUI's update button keeps working.
  RUN_ARGS+=("-v" "/var/run/docker.sock:/var/run/docker.sock")
  RUN_ARGS+=("-e" "HOST_REPO_DIR=${REPO_DIR}")
  RUN_ARGS+=("-e" "HOST_DATA_DIR=${DATA_DIR}")
  RUN_ARGS+=("-e" "MAIN_CONTAINER=${CONTAINER_NAME}")
  RUN_ARGS+=("-e" "MAIN_IMAGE=${IMAGE_NAME}")
  RUN_ARGS+=("-e" "UPDATER_IMAGE=${UPDATER_IMAGE}")
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    RUN_ARGS+=("-e" "GITHUB_TOKEN=${GITHUB_TOKEN}")
  fi

  docker run -d "${RUN_ARGS[@]}" "$IMAGE_NAME" || fail "Container-Start fehlgeschlagen"
  ok "Container aus Unraid-Template erstellt"
fi

# ── 5. Health check ──────────────────────────────────────────
info "Warte auf Health-Check..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:3000/api/health" &>/dev/null; then
    ok "Health-Check OK"
    break
  fi
  [ "$i" -eq 30 ] && fail "Health-Check fehlgeschlagen nach 30s — pruefe Logs: docker logs $CONTAINER_NAME"
  sleep 1
done

# ── Done ─────────────────────────────────────────────────────
echo -e "\n${B}${G}=== Update erfolgreich! ===${N}"
echo -e "  Version:  ${OLD_HASH} → ${B}${NEW_HASH}${N}"
echo -e "  Web-UI:   http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):3000"
echo ""
