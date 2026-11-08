#!/usr/bin/env bash
# Checks a running TaskFlow stack answers through nginx, the way a user reaches it.
# Used by CI (source build, published release, live site) and runnable locally in Git Bash:
#   scripts/smoke-test.sh http://localhost:3000              # signs up one throwaway user (test stacks only)
#   scripts/smoke-test.sh --read-only https://<live-site>    # signs in with the demo login instead; changes nothing
# Every check must pass: the first failure prints what failed and exits non-zero.
set -euo pipefail

READ_ONLY=false
if [ "${1:-}" = "--read-only" ]; then READ_ONLY=true; shift; fi
BASE="${1:-http://localhost:3000}"

pass() { echo "✓ $1"; }
fail() { echo "✗ $1" >&2; exit 1; }
# expect <label> <text> <curl args...>: the response must succeed and contain <text>.
expect() {
  local label="$1" text="$2"; shift 2
  local body
  body=$(curl -fsS "$@") || fail "$label (request failed)"
  grep -qi -- "$text" <<<"$body" || fail "$label (response doesn't contain $text)"
  pass "$label"
}

expect "app page" '<div id="root">' "$BASE/"
expect "API health" '"ok"' "$BASE/api/health/"
expect "API schema" 'openapi' "$BASE/api/schema/"
expect "Django admin" 'csrfmiddlewaretoken' "$BASE/admin/login/"
expect "security headers" 'x-content-type-options: nosniff' -I "$BASE/"

if [ "$READ_ONLY" = true ]; then
  # Signing in exercises nginx, Django and the database without creating anything.
  expect "demo sign-in" '"access"' -X POST "$BASE/api/auth/token/" -H 'Content-Type: application/json' \
    -d '{"email":"owner@acme.test","password":"demo12345"}'
else
  # Signing up exercises nginx, Django, PostgreSQL and the migrations end to end.
  EMAIL="smoke-$(date +%s)-$RANDOM@example.com"
  SIGNUP=$(curl -fsS -X POST "$BASE/api/auth/register/" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"Smoke-test-123\",\"workspace_name\":\"Smoke\"}") \
    || fail "sign-up (request failed)"
  grep -q '"access"' <<<"$SIGNUP" || fail "sign-up (no token returned)"
  pass "sign-up ($EMAIL)"
  # The Celery worker builds reports through Redis, so this proves the background-job side works too.
  TOKEN=$(sed -E 's/.*"access": ?"([^"]+)".*/\1/' <<<"$SIGNUP")
  SLUG=$(sed -E 's/.*"workspace": ?"([^"]+)".*/\1/' <<<"$SIGNUP")
  AUTH=(-H "Authorization: Bearer $TOKEN" -H "X-Workspace: $SLUG")
  curl -fsS -X POST "${AUTH[@]}" "$BASE/api/reports/generate/" -o /dev/null || fail "queue a report (request failed)"
  built=false
  for _ in $(seq 1 45); do
    if curl -fsS "${AUTH[@]}" "$BASE/api/reports/" | grep -q '"created_at"'; then built=true; break; fi
    sleep 2
  done
  [ "$built" = true ] || fail "Celery job: the worker didn't build the report within 90 s"
  pass "Celery job (weekly report built by the worker)"
fi

echo "Smoke test passed for $BASE"
