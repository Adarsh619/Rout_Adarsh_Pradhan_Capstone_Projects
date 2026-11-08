#!/usr/bin/env bash
# Checks a running TaskFlow stack answers through nginx, the way a user reaches it.
# Used by CI (source build, published release, live site) and runnable locally in Git Bash:
#   scripts/smoke-test.sh http://localhost:3000              # signs up one throwaway user (test stacks only)
#   scripts/smoke-test.sh --read-only https://<live-site>    # signs in with the demo login instead; changes nothing
set -euo pipefail

READ_ONLY=false
if [ "${1:-}" = "--read-only" ]; then READ_ONLY=true; shift; fi
BASE="${1:-http://localhost:3000}"

check() { echo "✓ $1"; }

curl -fsS "$BASE/" | grep -q '<div id="root">' && check "app page"
curl -fsS "$BASE/api/health/" | grep -q '"ok"' && check "API health"
curl -fsS "$BASE/api/schema/" -o /dev/null && check "API schema"
curl -fsS "$BASE/admin/login/" -o /dev/null && check "Django admin"
curl -fsSI "$BASE/" | grep -qi 'x-content-type-options: nosniff' && check "security headers"

if [ "$READ_ONLY" = true ]; then
  # Signing in exercises nginx, Django and the database without creating anything.
  curl -fsS -X POST "$BASE/api/auth/token/" -H 'Content-Type: application/json' \
    -d '{"email":"owner@acme.test","password":"demo12345"}' | grep -q '"access"' && check "demo sign-in"
else
  # Signing up exercises nginx, Django, PostgreSQL and the migrations end to end.
  EMAIL="smoke-$(date +%s)-$RANDOM@example.com"
  SIGNUP=$(curl -fsS -X POST "$BASE/api/auth/register/" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"Smoke-test-123\",\"workspace_name\":\"Smoke\"}")
  echo "$SIGNUP" | grep -q '"access"' && check "sign-up ($EMAIL)"
  # The Celery worker builds reports through Redis, so this proves the background-job side works too.
  TOKEN=$(echo "$SIGNUP" | sed -E 's/.*"access": ?"([^"]+)".*/\1/')
  SLUG=$(echo "$SIGNUP" | sed -E 's/.*"workspace": ?"([^"]+)".*/\1/')
  AUTH=(-H "Authorization: Bearer $TOKEN" -H "X-Workspace: $SLUG")
  curl -fsS -X POST "${AUTH[@]}" "$BASE/api/reports/generate/" -o /dev/null
  for _ in $(seq 1 45); do
    curl -fsS "${AUTH[@]}" "$BASE/api/reports/" | grep -q '"created_at"' && break
    sleep 2
  done
  curl -fsS "${AUTH[@]}" "$BASE/api/reports/" | grep -q '"created_at"' \
    && check "Celery job (weekly report built by the worker)" \
    || { echo "✗ the Celery worker didn't build the report within 90 s"; exit 1; }
fi

echo "Smoke test passed for $BASE"
