#!/usr/bin/env bash
# One-command deploy to a fresh Ubuntu/Debian VPS (Hetzner, DigitalOcean, Lightsail...).
#
#   ./deploy/remote_deploy.sh root@1.2.3.4
#
# On the box: installs Docker if missing, syncs this repo (never .venv / data / .git), copies your local
# .env, builds the image, runs the PREFLIGHT inside the container, and only if every check passes starts
# agent + api + caddy with docker compose (restart: unless-stopped => survives reboots).
set -euo pipefail

TARGET="${1:?usage: remote_deploy.sh user@host}"
REMOTE_DIR="/opt/trading-agent"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="docker compose -f deploy/docker-compose.yml"

[ -f "$HERE/.env" ] || { echo "no .env in $HERE - create it from .env.example first"; exit 1; }
# shellcheck disable=SC2046
export $(grep -E '^(DASHBOARD_HOST|DASHBOARD_TOKEN)=' "$HERE/.env" | xargs) || true
[ -n "${DASHBOARD_HOST:-}" ] || { echo "DASHBOARD_HOST is empty in .env (e.g. 1-2-3-4.sslip.io) - see deploy/HETZNER.md step 4"; exit 1; }
[ -n "${DASHBOARD_TOKEN:-}" ] || { echo "DASHBOARD_TOKEN is empty in .env - generate: openssl rand -hex 24"; exit 1; }

echo "==> installing docker on $TARGET (if needed)"
ssh "$TARGET" 'command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sh); docker compose version >/dev/null'

echo "==> syncing code (config.yaml is NOT synced: the server copy is edited from the admin panel; first deploy copies it)"
ssh "$TARGET" "test -f $REMOTE_DIR/config.yaml" 2>/dev/null || scp -q "$HERE/config.yaml" "$TARGET:$REMOTE_DIR/config.yaml"
ssh "$TARGET" "mkdir -p $REMOTE_DIR/data"
rsync -az --delete \
  --exclude .venv --exclude data --exclude backups --exclude config.yaml --exclude __pycache__ --exclude '*.pyc' --exclude .git --exclude ui \
  "$HERE/" "$TARGET:$REMOTE_DIR/"
scp -q "$HERE/.env" "$TARGET:$REMOTE_DIR/.env"
ssh "$TARGET" "chmod 600 $REMOTE_DIR/.env"

echo "==> building image"
ssh "$TARGET" "cd $REMOTE_DIR && $COMPOSE build -q agent"

echo "==> preflight on the server"
if ! ssh "$TARGET" "cd $REMOTE_DIR && $COMPOSE run --rm --no-deps agent python scripts/preflight.py"; then
  echo
  echo "PREFLIGHT FAILED on $TARGET - agent NOT started. Fix the failing checks and re-run."
  exit 1
fi

echo "==> starting agent + api + caddy"
ssh "$TARGET" "cd $REMOTE_DIR && $COMPOSE up -d --remove-orphans"
sleep 5
ssh "$TARGET" "cd $REMOTE_DIR && $COMPOSE ps"

echo
echo "==> waiting for HTTPS certificate (Let's Encrypt, usually < 60s)"
for i in $(seq 1 12); do
  if curl -fsS --max-time 5 "https://$DASHBOARD_HOST/api/health" >/dev/null 2>&1; then
    echo "dashboard API live: https://$DASHBOARD_HOST/api/health"; break
  fi
  sleep 5
  [ "$i" -eq 12 ] && echo "not reachable yet - check: ssh $TARGET 'cd $REMOTE_DIR && $COMPOSE logs caddy'"
done

echo
echo "deployed. useful commands:"
echo "  ssh $TARGET 'cd $REMOTE_DIR && $COMPOSE logs -f --tail 100 agent'"
echo "  ssh $TARGET 'cd $REMOTE_DIR && $COMPOSE run --rm --no-deps agent python scripts/status.py'"
echo "  ssh $TARGET 'touch $REMOTE_DIR/data/KILL'      # emergency: flatten everything and stop"
echo
echo "dashboard: open the GitHub Pages UI -> gear -> API base https://$DASHBOARD_HOST , token from .env"
