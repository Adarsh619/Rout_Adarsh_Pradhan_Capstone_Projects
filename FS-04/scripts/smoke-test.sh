#!/usr/bin/env bash
# Checks a running TaskFlow stack answers through nginx, the way a user reaches it.
# Used by CI (source build and published release) and runnable locally in Git Bash:
#   scripts/smoke-test.sh http://localhost:3000
# It signs up one throwaway user, so point it at a test stack, not at real data.
set -euo pipefail

BASE="${1:-http://localhost:3000}"
EMAIL="smoke-$(date +%s)-$RANDOM@example.com"

check() { echo "✓ $1"; }

curl -fsS "$BASE/" | grep -q '<div id="root">' && check "app page"
curl -fsS "$BASE/api/health/" | grep -q '"ok"' && check "API health"
curl -fsS "$BASE/api/schema/" -o /dev/null && check "API schema"
curl -fsS "$BASE/admin/login/" -o /dev/null && check "Django admin"
curl -fsSI "$BASE/" | grep -qi 'x-content-type-options: nosniff' && check "security headers"
# Signing up exercises nginx, Django, PostgreSQL and the migrations end to end.
curl -fsS -X POST "$BASE/api/auth/register/" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Smoke-test-123\",\"workspace_name\":\"Smoke\"}" | grep -q '"access"' \
  && check "sign-up ($EMAIL)"

echo "Smoke test passed for $BASE"
