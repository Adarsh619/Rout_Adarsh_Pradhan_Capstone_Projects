#!/usr/bin/env bash
# Checks a running ShopSphere stack answers through nginx, the way a visitor reaches it.
# Used by CI and runnable locally in Git Bash:  scripts/smoke-test.sh http://localhost:3000
set -euo pipefail

BASE="${1:-http://localhost:3000}"

check() { echo "✓ $1"; }

curl -fsS "$BASE/" | grep -q '<div id="root">' && check "app page"
curl -fsSI "$BASE/" | grep -qi 'x-content-type-options: nosniff' && check "security headers"
curl -fsS "$BASE/some/deep/link" | grep -q '<div id="root">' && check "client-side routes fall back to the app"
HEALTH="$(curl -fsS "$BASE/api/v1/health")"
for svc in mongo redis elasticsearch s3; do
  echo "$HEALTH" | grep -q "\"$svc\":\"up\"" && check "$svc is up"
done
curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/v1/nope" | grep -q 404 && check "unknown API route returns 404"

echo "Smoke test passed for $BASE"
