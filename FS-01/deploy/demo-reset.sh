#!/usr/bin/env bash
# Puts the live demo back to a known state. Run nightly at 03:00 IST by shopsphere-reset.timer.
#   bash deploy/demo-reset.sh --save      # once: snapshot the current (clean, seeded) database as the baseline
#   bash deploy/demo-reset.sh             # restore the baseline: database, empty Redis, rebuilt search index
# Restoring keeps every id, so product photos already in S3 stay valid and nothing is downloaded again.
# Sessions and carts live in Redis, so everyone is signed out by a reset.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # FS-01/
STATE_DIR="${STATE_DIR:-$HOME/.shopsphere}"
BASELINE="${BASELINE:-$STATE_DIR/baseline.archive.gz}"
MONGO_TOOLS_IMAGE="mongo:7.0.45"   # same version as the local database; has mongodump / mongorestore
COMPOSE=(docker compose -f "${COMPOSE_FILE:-$APP_DIR/docker-compose.prod.yml}")
# Local testing only: run the Mongo tools on this Docker network, and skip Redis / API / worker.
DOCKER_NETWORK="${DOCKER_NETWORK:-}"
SKIP_SERVICES="${SKIP_SERVICES:-0}"

log() { echo "$(date -u +%FT%TZ) reset: $*"; }

# MONGO_URL from the environment, else from FS-01/.env (never printed).
mongo_url() {
  if [[ -n "${MONGO_URL:-}" ]]; then printf '%s' "$MONGO_URL"; return; fi
  grep -m1 '^MONGO_URL=' "$APP_DIR/.env" | cut -d= -f2-
}

# The database name is the path of the URL: mongodb+srv://u:p@host/<db>?options
db_name() { sed -E 's#^[a-z+]+://[^/]+/([^?]*).*#\1#' <<<"$1"; }

mongo_tool() {
  local net=(); [[ -n "$DOCKER_NETWORK" ]] && net=(--network "$DOCKER_NETWORK")
  # The URL goes in through the environment, so it never appears in a process list.
  docker run --rm -i "${net[@]}" -e MONGO_URL -v "$STATE_DIR:/backup" "$MONGO_TOOLS_IMAGE" sh -c "$1"
}

wait_healthy() {
  for _ in $(seq 1 40); do
    if "${COMPOSE[@]}" exec -T api wget -q -O /dev/null http://localhost:4000/api/v1/health 2>/dev/null; then return 0; fi
    sleep 5
  done
  return 1
}

main() {
  mkdir -p "$STATE_DIR"
  exec 9>"$STATE_DIR/lock"
  flock -w 900 9 || { log "a deploy is still running after 15 min; skipping tonight"; return 1; }

  MONGO_URL="$(mongo_url)"; export MONGO_URL
  [[ -n "$MONGO_URL" ]] || { log "MONGO_URL is not set"; return 1; }
  local db; db="$(db_name "$MONGO_URL")"
  [[ -n "$db" ]] || { log "MONGO_URL has no database name (…mongodb.net/shopsphere?…)"; return 1; }
  local file; file="/backup/$(basename "$BASELINE")"

  if [[ "${1:-}" == "--save" ]]; then
    log "saving baseline of database '$db'"
    mongo_tool "mongodump --quiet --uri=\"\$MONGO_URL\" --gzip --archive=$file"
    log "baseline saved: $BASELINE ($(du -h "$BASELINE" | cut -f1))"
    return 0
  fi

  [[ -s "$BASELINE" ]] || { log "no baseline yet; run: bash deploy/demo-reset.sh --save"; return 1; }

  if [[ "$SKIP_SERVICES" != 1 ]]; then
    log "stopping api and worker"
    "${COMPOSE[@]}" stop api worker
  fi

  log "restoring database '$db' from the baseline"
  # Drop every collection first: --drop alone only replaces collections that are in the baseline, so anything created
  # after the snapshot would survive. Dropping collections (not the database) needs only readWrite. Only $db is touched.
  mongo_tool "mongosh --quiet \"\$MONGO_URL\" --eval 'db.getCollectionNames().forEach((c) => db.getCollection(c).drop())'"
  mongo_tool "mongorestore --quiet --uri=\"\$MONGO_URL\" --gzip --archive=$file --drop --nsInclude='$db.*'"

  if [[ "$SKIP_SERVICES" != 1 ]]; then
    log "clearing Redis (sessions, carts, caches, job queues)"
    "${COMPOSE[@]}" exec -T redis redis-cli FLUSHDB >/dev/null
    log "starting api and worker"
    "${COMPOSE[@]}" start api worker
    wait_healthy || { log "API not healthy after the reset"; return 1; }
    log "rebuilding the search index"
    "${COMPOSE[@]}" exec -T api node dist/scripts/reindex.js >/dev/null
  fi
  log "done"
}

main "$@"
exit $?
