#!/usr/bin/env bash
# Pull-based deploy, run every 5 minutes by shopsphere-deploy.timer on the server.
# Asks GitHub for the newest commit on main whose FS-01 CI run PASSED; if the server runs something older, it
# fast-forwards to that commit and rebuilds. Nothing reaches into the server: no inbound SSH from GitHub, no keys in CI.
#   bash deploy/auto-deploy.sh            # normal run (does nothing when up to date)
#   bash deploy/auto-deploy.sh --force    # rebuild the passing commit even if it was tried before
set -euo pipefail

REPO_SLUG="${REPO_SLUG:-Adarsh619/Rout_Adarsh_Pradhan_Capstone_Projects}"
WORKFLOW="${WORKFLOW:-fs01-ci.yml}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # FS-01/
STATE_DIR="${STATE_DIR:-$HOME/.shopsphere}"
COMPOSE=(docker compose -f "$APP_DIR/docker-compose.prod.yml")

log() { echo "$(date -u +%FT%TZ) deploy: $*"; }

# The newest successful push run of the CI workflow on main → its commit sha (empty if none / GitHub unreachable).
passing_sha() {
  curl -fsS --max-time 20 -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO_SLUG/actions/workflows/$WORKFLOW/runs?branch=main&event=push&status=success&per_page=1" |
    python3 -c 'import json,sys; r=json.load(sys.stdin).get("workflow_runs") or []; print(r[0]["head_sha"] if r else "")'
}

wait_healthy() {
  for _ in $(seq 1 40); do
    if "${COMPOSE[@]}" exec -T api wget -q -O /dev/null http://localhost:4000/api/v1/health 2>/dev/null; then return 0; fi
    sleep 5
  done
  return 1
}

# Everything runs inside main(), which bash has fully read before `git merge` can rewrite this very file.
main() {
  mkdir -p "$STATE_DIR"
  # One deploy or reset at a time.
  exec 9>"$STATE_DIR/lock"
  flock -n 9 || { log "another deploy/reset is running; skipping"; return 0; }

  cd "$APP_DIR"
  local target current tried
  target="$(passing_sha || true)"
  [[ -n "$target" ]] || { log "couldn't read CI status from GitHub; skipping"; return 0; }
  current="$(git rev-parse HEAD)"
  tried="$(cat "$STATE_DIR/last-attempt" 2>/dev/null || true)"

  if [[ "$current" == "$target" && "${1:-}" != "--force" ]]; then return 0; fi
  if [[ "$tried" == "$target" && "${1:-}" != "--force" ]]; then return 0; fi   # failed before; wait for a newer commit

  log "deploying ${target:0:7} (running ${current:0:7})"
  echo "$target" > "$STATE_DIR/last-attempt"
  git fetch --quiet origin main
  if ! git merge-base --is-ancestor "$current" "$target"; then
    log "${target:0:7} is not ahead of ${current:0:7}; not deploying"; return 1
  fi
  git merge --quiet --ff-only "$target"

  # Images are built while the old containers keep serving; only then are they swapped (a few seconds).
  export APP_VERSION="${target:0:7}"
  if ! "${COMPOSE[@]}" up -d --build --remove-orphans; then
    log "build/start failed for ${target:0:7}"; return 1
  fi
  # git replaces a changed file with a new one, and a running container keeps seeing the old one it mounted.
  if ! git diff --quiet "$current" "$target" -- deploy/Caddyfile; then
    log "Caddyfile changed; restarting caddy"
    "${COMPOSE[@]}" restart caddy
  fi
  if wait_healthy; then
    log "live: ${target:0:7}"
  else
    log "API not healthy after deploying ${target:0:7}; check: docker compose -f docker-compose.prod.yml logs api"
    return 1
  fi
  docker image prune -f >/dev/null || true
}

main "$@"
exit $?
