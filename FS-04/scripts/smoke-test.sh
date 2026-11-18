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
# field <name>: read one top-level field from the JSON on stdin.
field() { node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }

expect "app page" '<div id="root">' "$BASE/"
expect "API health" '"ok"' "$BASE/api/health/"
expect "API schema" 'openapi' "$BASE/api/schema/"
expect "API docs" 'swagger' "$BASE/api/docs/"
expect "security headers" 'x-content-type-options: nosniff' -I "$BASE/"

if [ "$READ_ONLY" = true ]; then
  # Signing in exercises nginx, the API and the database without creating anything.
  expect "demo sign-in" '"access"' -X POST "$BASE/api/auth/token/" -H 'Content-Type: application/json' \
    -d '{"email":"owner@acme.test","password":"demo12345"}'
else
  # Signing up exercises nginx, the API, PostgreSQL and the migrations end to end.
  EMAIL="smoke-$(date +%s)-$RANDOM@example.com"
  SIGNUP=$(curl -fsS -X POST "$BASE/api/auth/register/" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"Smoke-test-123\",\"workspace_name\":\"Smoke\"}") \
    || fail "sign-up (request failed)"
  grep -q '"access"' <<<"$SIGNUP" || fail "sign-up (no token returned)"
  pass "sign-up ($EMAIL)"
  TOKEN=$(field access <<<"$SIGNUP")
  SLUG=$(field workspace <<<"$SIGNUP")
  AUTH=(-H "Authorization: Bearer $TOKEN" -H "X-Workspace: $SLUG")
  JSON=(-H 'Content-Type: application/json')

  # The core flow a user goes through: a project with its board, an issue, a drag to the next column, a comment.
  PROJECT=$(curl -fsS -X POST "${AUTH[@]}" "${JSON[@]}" "$BASE/api/projects/" -d '{"key":"SMK","name":"Smoke"}')     || fail "create a project (request failed)"
  PROJECT_ID=$(field id <<<"$PROJECT")
  BOARD_ID=$(field board_id <<<"$PROJECT")
  pass "project with its board"
  ISSUE=$(curl -fsS -X POST "${AUTH[@]}" "${JSON[@]}" "$BASE/api/issues/" -d "{\"project\":$PROJECT_ID,\"title\":\"Smoke issue\"}")     || fail "create an issue (request failed)"
  ISSUE_ID=$(field id <<<"$ISSUE")
  grep -q '"key":"SMK-1"' <<<"$ISSUE" || fail "create an issue (expected key SMK-1)"
  pass "issue SMK-1"
  NEXT=$(curl -fsS "${AUTH[@]}" "$BASE/api/boards/$BOARD_ID/columns/" | node -e     'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).columns[1].status.id))')     || fail "board columns (request failed)"
  expect "drag to the next column" "\"status\":$NEXT" -X POST "${AUTH[@]}" "${JSON[@]}" "$BASE/api/issues/$ISSUE_ID/move/"     -d "{\"status\":$NEXT,\"index\":0}"
  expect "comment" '"body":"Looks good"' -X POST "${AUTH[@]}" "${JSON[@]}" "$BASE/api/comments/"     -d "{\"issue\":$ISSUE_ID,\"body\":\"Looks good\"}"
  expect "audit log" '"issue.moved"' "${AUTH[@]}" "$BASE/api/audit-logs/?kind=issue"
  # Billing in mock mode: Stripe SDK calls to stripe-mock, then signed webhooks through the real handler.
  expect "mock checkout (Stripe)" '"plan":"pro"' -X POST "${AUTH[@]}" "${JSON[@]}" "$BASE/api/billing/mock/complete/" -d '{"plan":"pro"}'

  # The worker builds reports from the Redis queue, so this proves the background-job side works too.
  curl -fsS -X POST "${AUTH[@]}" "$BASE/api/reports/generate/" -o /dev/null || fail "queue a report (request failed)"
  built=false
  for _ in $(seq 1 45); do
    if curl -fsS "${AUTH[@]}" "$BASE/api/reports/" | grep -q '"created_at"'; then built=true; break; fi
    sleep 2
  done
  [ "$built" = true ] || fail "background job: the worker didn't build the report within 90 s"
  pass "background job (weekly report built by the worker)"
fi

echo "Smoke test passed for $BASE"
