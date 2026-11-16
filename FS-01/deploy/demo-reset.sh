#!/usr/bin/env bash
# Puts the live demo back to a known state. Run nightly at 03:00 IST by shopsphere-reset.timer.
#   bash deploy/demo-reset.sh --save      # once: snapshot the current (clean, seeded) database as the baseline
#   bash deploy/demo-reset.sh             # restore the baseline: database, empty Redis, rebuilt search index
# Restoring keeps every id, so product photos already in S3 stay valid and nothing is downloaded again.
# Sessions and carts live in Redis, so everyone is signed out by a reset.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # FS-01/
STATE_DIR="${STATE_DIR:-$HOME/.shopsphere}"
BASELINE="${BASELINE:-$STATE_DIR/baseline.dump}"
COMPOSE=(docker compose -f "${COMPOSE_FILE:-$APP_DIR/docker-compose.prod.yml}")
# Local testing only: restore the database but leave Redis, the API and the worker alone.
SKIP_SERVICES="${SKIP_SERVICES:-0}"
DB=(-U shopsphere -d shopsphere)

log() { echo "$(date -u +%FT%TZ) reset: $*"; }

# Runs a PostgreSQL tool inside the postgres container (it has the same version as the server, and no password is
# needed there: the tools connect over the container's own socket).
pg() { "${COMPOSE[@]}" exec -T postgres "$@"; }

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

  if [[ "${1:-}" == "--save" ]]; then
    log "saving baseline of the database"
    # Custom format: compressed, and restores tables, indexes, sequences and the migration history.
    pg pg_dump "${DB[@]}" --format=custom --no-owner >"$BASELINE.tmp"
    mv "$BASELINE.tmp" "$BASELINE"
    log "baseline saved: $BASELINE ($(du -h "$BASELINE" | cut -f1))"
    return 0
  fi

  [[ -s "$BASELINE" ]] || { log "no baseline yet; run: bash deploy/demo-reset.sh --save"; return 1; }

  if [[ "$SKIP_SERVICES" != 1 ]]; then
    log "stopping api and worker"
    "${COMPOSE[@]}" stop api worker
  fi

  log "restoring the database from the baseline"
  # Start from an empty schema, so tables or rows created after the snapshot can't survive, then restore it all in one
  # transaction: if anything fails, the restore is rolled back as a whole.
  pg psql "${DB[@]}" -q -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
  pg pg_restore "${DB[@]}" --no-owner --single-transaction --exit-on-error <"$BASELINE"

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
