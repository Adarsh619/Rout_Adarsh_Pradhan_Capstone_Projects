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
  ADMIN_LOGIN="$(json -X POST "$BASE/api/v1/auth/login" -d "{\"email\":\"admin@shopsphere.test\",\"password\":\"$DEMO_PASSWORD\"}")"
  echo "$ADMIN_LOGIN" | grep -q '"role":"admin"' && check "seeded admin can sign in"
  ADMIN="$(echo "$ADMIN_LOGIN" | field accessToken)"
  as_admin() { curl -fsS -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN" "$@"; }

  # A new vendor applies, the admin approves, a photo goes straight to S3 and the product goes on sale.
  VENDOR_EMAIL="smoke-vendor-$(date +%s)-$RANDOM@example.com"
  VENDOR="$(json -X POST "$BASE/api/v1/auth/register" \
    -d "{\"name\":\"Smoke Vendor\",\"email\":\"$VENDOR_EMAIL\",\"password\":\"Smoke-test-123\",\"role\":\"vendor\"}" | field accessToken)"
  as_vendor() { curl -fsS -H 'Content-Type: application/json' -H "Authorization: Bearer $VENDOR" "$@"; }
  STORE="$(as_vendor -X POST "$BASE/api/v1/vendors/apply" \
    -d '{"storeName":"Smoke Test Store","contactEmail":"smoke@example.com","phone":"9876543210"}')"
  STORE_ID="$(echo "$STORE" | field id)"
  STORE_SLUG="$(echo "$STORE" | field slug)"
  echo "$STORE" | grep -q '"status":"pending"' && check "vendor applies for a store"
  as_admin -X POST "$BASE/api/v1/admin/vendors/$STORE_ID/approve" | grep -q '"status":"approved"' && check "admin approves it"

  DEPT="$(as_admin -X POST "$BASE/api/v1/admin/categories" -d '{"name":"Smoke Department"}' | field id)"
  CATEGORY="$(as_admin -X POST "$BASE/api/v1/admin/categories" -d "{\"name\":\"Smoke Category\",\"parentId\":\"$DEPT\"}" | field id)"
  [ -n "$CATEGORY" ] && check "admin adds categories"

  PHOTO="$(mktemp)"
  printf '\x89PNG\r\n\x1a\nsmoke-test-image' > "$PHOTO"
  SIZE="$(wc -c < "$PHOTO" | tr -d ' ')"
  SIGNED="$(as_vendor -X POST "$BASE/api/v1/uploads/presign" -d "{\"purpose\":\"product-image\",\"contentType\":\"image/png\",\"size\":$SIZE}")"
  KEY="$(echo "$SIGNED" | field key)"
  curl -fsS -X PUT -H 'Content-Type: image/png' --data-binary "@$PHOTO" "$(echo "$SIGNED" | field uploadUrl)" -o /dev/null \
    && check "photo uploads straight to storage with a signed link"
  rm -f "$PHOTO"

  PRODUCT="$(as_vendor -X POST "$BASE/api/v1/vendor/products" -d "{\"title\":\"Smoke Test Phone\",\"categoryId\":\"$CATEGORY\",\
\"price\":1999900,\"mrp\":2499900,\"stock\":5,\"status\":\"active\",\"images\":[{\"key\":\"$KEY\",\"alt\":\"Front\"}]}")"
  PRODUCT_ID="$(echo "$PRODUCT" | field id)"
  [ -n "$PRODUCT_ID" ] && check "vendor publishes a product"
  PAGE="$(curl -fsS "$BASE/api/v1/products/$PRODUCT_ID")"
  echo "$PAGE" | grep -q '"discountPercent":20' && check "product page shows it with its discount"
  curl -fsS -o /dev/null "$(echo "$PAGE" | field url)" && check "its photo is served from storage"
  curl -fsS "$BASE/api/v1/stores/$STORE_SLUG" | grep -q "\"id\":\"$PRODUCT_ID\"" && check "it's listed on the store page"
fi

echo "Smoke test passed for $BASE"
