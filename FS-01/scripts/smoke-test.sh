#!/usr/bin/env bash
# Checks a running ShopSphere stack answers through nginx, the way a visitor reaches it.
# Used by CI and runnable locally in Git Bash:  scripts/smoke-test.sh http://localhost:3000
# It signs up one throwaway customer, so point it at a test stack, not at real data.
# If DEMO_PASSWORD is set, it also signs in as the seeded admin.
set -euo pipefail

BASE="${1:-http://localhost:3000}"
EMAIL="smoke-$(date +%s)-$RANDOM@example.com"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

check() { echo "✓ $1"; }
json() { curl -fsS -H 'Content-Type: application/json' -H 'X-Requested-With: ShopSphere' -b "$JAR" -c "$JAR" "$@"; }
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

curl -fsS "$BASE/" | grep -q '<div id="root">' && check "app page"
curl -fsSI "$BASE/" | grep -qi 'x-content-type-options: nosniff' && check "security headers"
curl -fsS "$BASE/some/deep/link" | grep -q '<div id="root">' && check "client-side routes fall back to the app"
HEALTH="$(curl -fsS "$BASE/api/v1/health")"
for svc in mongo redis elasticsearch s3; do
  echo "$HEALTH" | grep -q "\"$svc\":\"up\"" && check "$svc is up"
done
curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/v1/nope" | grep -q 404 && check "unknown API route returns 404"

# Sign-up goes through nginx, Express, MongoDB and Redis (session) end to end.
TOKEN="$(json -X POST "$BASE/api/v1/auth/register" \
  -d "{\"name\":\"Smoke Test\",\"email\":\"$EMAIL\",\"password\":\"Smoke-test-123\"}" | field accessToken)"
[ -n "$TOKEN" ] && check "sign-up ($EMAIL)"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/auth/me" | grep -q "\"email\":\"$EMAIL\"" && check "signed-in user"
json -X POST "$BASE/api/v1/auth/refresh" | grep -q '"accessToken"' && check "refresh cookie rotates the session"
json -X POST "$BASE/api/v1/auth/logout" -o /dev/null && check "logout"
[ "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/auth/me")" = 401 ] \
  && check "access token stops working after logout"

if [ -n "${DEMO_PASSWORD:-}" ]; then
  json -X POST "$BASE/api/v1/auth/login" -d "{\"email\":\"admin@shopsphere.test\",\"password\":\"$DEMO_PASSWORD\"}" \
    | grep -q '"role":"admin"' && check "seeded admin can sign in"
fi

echo "Smoke test passed for $BASE"
