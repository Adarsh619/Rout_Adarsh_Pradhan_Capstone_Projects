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

  PRODUCT="$(as_vendor -X POST "$BASE/api/v1/vendor/products" -d "{\"title\":\"Smoke Test Phone\",\"categoryId\":\"$CATEGORY\",\
\"price\":1999900,\"mrp\":2499900,\"stock\":5,\"status\":\"active\",\"images\":[{\"key\":\"$KEY\",\"alt\":\"Front\"}]}")"
  PRODUCT_ID="$(echo "$PRODUCT" | field id)"
  [ -n "$PRODUCT_ID" ] && check "vendor publishes a product"
  PAGE="$(curl -fsS "$BASE/api/v1/products/$PRODUCT_ID")"
  echo "$PAGE" | grep -q '"discountPercent":20' && check "product page shows it with its discount"
  curl -fsS -o /dev/null "$(echo "$PAGE" | field url)" && check "its photo is served from storage"
  curl -fsS "$BASE/api/v1/stores/$STORE_SLUG" | grep -q "\"id\":\"$PRODUCT_ID\"" && check "it's listed on the store page"

  # The background worker picks up the change and indexes it; search (with a typo) finds it within seconds.
  for i in $(seq 1 30); do
    curl -fsS "$BASE/api/v1/search?q=smoke%20tset%20phone" | grep -q "\"id\":\"$PRODUCT_ID\"" && break
    [ "$i" = 30 ] && { echo "✗ search never found the new product"; exit 1; }
    sleep 1
  done
  check "the worker indexes it and search finds it (typo included) after ${i}s"
  curl -fsS "$BASE/api/v1/search/suggest?q=smoke%20te" | grep -q '"title":"Smoke Test Phone"' && check "autocomplete suggests it"

  # A guest fills a cart from two stores, signs up (the cart follows), checks out and pays on the test gateway.
  GUEST_JAR="$(mktemp)"
  as_guest() { curl -fsS -H 'Content-Type: application/json' -H 'X-Requested-With: ShopSphere' -b "$GUEST_JAR" -c "$GUEST_JAR" "$@"; }
  # A second store (CI's seeded products have no photos, so they stay drafts), so the cart spans two sellers.
  VENDOR2="$(json -X POST "$BASE/api/v1/auth/register" \
    -d "{\"name\":\"Smoke Vendor Two\",\"email\":\"smoke-vendor2-$(date +%s)-$RANDOM@example.com\",\"password\":\"Smoke-test-123\",\"role\":\"vendor\"}" | field accessToken)"
  as_vendor2() { curl -fsS -H 'Content-Type: application/json' -H "Authorization: Bearer $VENDOR2" "$@"; }
  STORE2_ID="$(as_vendor2 -X POST "$BASE/api/v1/vendors/apply" \
    -d '{"storeName":"Smoke Second Store","contactEmail":"smoke2@example.com","phone":"9876543210"}' | field id)"
  as_admin -X POST "$BASE/api/v1/admin/vendors/$STORE2_ID/approve" -o /dev/null
  SIGNED2="$(as_vendor2 -X POST "$BASE/api/v1/uploads/presign" -d "{\"purpose\":\"product-image\",\"contentType\":\"image/png\",\"size\":$SIZE}")"
  curl -fsS -X PUT -H 'Content-Type: image/png' --data-binary "@$PHOTO" "$(echo "$SIGNED2" | field uploadUrl)" -o /dev/null
  OTHER_ID="$(as_vendor2 -X POST "$BASE/api/v1/vendor/products" -d "{\"title\":\"Smoke Test Cable\",\"categoryId\":\"$CATEGORY\",\
\"price\":29900,\"stock\":3,\"status\":\"active\",\"images\":[{\"key\":\"$(echo "$SIGNED2" | field key)\",\"alt\":\"Cable\"}]}" | field id)"
  rm -f "$PHOTO"
  as_guest -X POST "$BASE/api/v1/cart/items" -d "{\"productId\":\"$PRODUCT_ID\",\"qty\":1}" -o /dev/null
  as_guest -X POST "$BASE/api/v1/cart/items" -d "{\"productId\":\"$OTHER_ID\",\"qty\":1}" | grep -q '"itemCount":2' \
    && check "a guest adds products from two stores to the cart"
  SHOPPER="$(as_guest -X POST "$BASE/api/v1/auth/register" \
    -d "{\"name\":\"Smoke Shopper\",\"email\":\"smoke-shopper-$(date +%s)-$RANDOM@example.com\",\"password\":\"Smoke-test-123\"}" | field accessToken)"
  as_shopper() { curl -fsS -H 'Content-Type: application/json' -H 'X-Requested-With: ShopSphere' -H "Authorization: Bearer $SHOPPER" "$@"; }
  as_shopper "$BASE/api/v1/cart" | grep -q '"itemCount":2' && check "signing up keeps the guest's cart"
  # WELCOME10 comes with the demo catalogue: 10% off, up to ₹200, paid for by the platform.
  as_shopper -X POST "$BASE/api/v1/cart/coupon" -d '{"code":"welcome10"}' | grep -q '"discount":20000' && check "the WELCOME10 coupon takes ₹200 off"
  ADDRESS_ID="$(as_shopper -X POST "$BASE/api/v1/account/addresses" -d '{"name":"Smoke Shopper","phone":"9876543210",
"line1":"1 Test Street","city":"Bengaluru","state":"Karnataka","pincode":"560001"}' | sed -n 's/.*"address":{"id":"\([^"]*\)".*/\1/p')"
  CHECKOUT="$(as_shopper -X POST "$BASE/api/v1/checkout" -d "{\"addressId\":\"$ADDRESS_ID\"}")"
  ORDER_ID="$(echo "$CHECKOUT" | sed -n 's/.*"order":{"id":"\([^"]*\)".*/\1/p')"
  [ "$(echo "$CHECKOUT" | grep -o '"vendor":{"storeName"' | wc -l | tr -d ' ')" = 2 ] && check "checkout makes one order with a part per store"
  curl -fsS "$BASE/api/v1/products/$PRODUCT_ID" | grep -q '"stock":4' && check "the stock is reserved"
  PROVIDER_ORDER="$(echo "$CHECKOUT" | field providerOrderId)"
  PAID="$(as_shopper -X POST "$BASE/api/v1/payments/mock/pay" -d "{\"providerOrderId\":\"$PROVIDER_ORDER\"}")"
  as_shopper -X POST "$BASE/api/v1/checkout/verify" -d "{\"orderId\":\"$ORDER_ID\",\"providerOrderId\":\"$PROVIDER_ORDER\",\
\"providerPaymentId\":\"$(echo "$PAID" | field providerPaymentId)\",\"signature\":\"$(echo "$PAID" | field signature)\"}" \
    | grep -q '"status":"confirmed"' && check "the signed test payment is verified and the order confirmed"
  as_shopper "$BASE/api/v1/orders/$ORDER_ID" | grep -q '"discount":20000,' && check "the order was charged with the discount"
  PART_ID="$(as_vendor "$BASE/api/v1/vendor/orders" | sed -n 's/^{"items":\[{"id":"\([^"]*\)".*/\1/p')"
  as_vendor -X POST "$BASE/api/v1/vendor/orders/$PART_ID/status" -d '{"status":"packed"}' | grep -q '"status":"packed"' \
    && check "the vendor sees the paid order and packs it"
  as_shopper "$BASE/api/v1/orders/$ORDER_ID" | grep -q '"status":"packed"' && check "the customer sees it packed"

  # Escrow: the vendor's share is held until delivery, then the worker pays it out (simulated payouts).
  as_vendor "$BASE/api/v1/vendor/orders" | grep -q '"payout":{"status":"held"' && check "the vendor's share is held until delivery"
  as_vendor -X PUT "$BASE/api/v1/vendors/me/payout" -d '{"accountHolder":"Smoke Vendor","accountNumber":"123456789012","ifsc":"HDFC0001234"}' \
    | grep -q '"bankLast4":"9012"' && check "vendor adds payout details (only the last 4 digits are kept)"
  as_vendor -X POST "$BASE/api/v1/vendor/orders/$PART_ID/status" -d '{"status":"shipped","tracking":{"carrier":"Delhivery","number":"DL123456"}}' -o /dev/null
  as_vendor -X POST "$BASE/api/v1/vendor/orders/$PART_ID/status" -d '{"status":"delivered"}' -o /dev/null
  for i in $(seq 1 30); do
    as_vendor "$BASE/api/v1/vendor/orders" | grep -q '"payout":{"status":"paid"' && break
    [ "$i" = 30 ] && { echo "✗ the delivered share was never paid out"; exit 1; }
    sleep 1
  done
  check "delivery releases the share and the worker pays it out after ${i}s"

  # The worker made an invoice PDF for each store's part; the buyer gets a short-lived link to it.
  for i in $(seq 1 30); do
    INVOICE="$(as_shopper "$BASE/api/v1/invoices/$PART_ID" 2>/dev/null || true)"
    echo "$INVOICE" | grep -q '"url"' && break
    [ "$i" = 30 ] && { echo "✗ the invoice was never made"; exit 1; }
    sleep 1
  done
  curl -fsS "$(echo "$INVOICE" | field url)" | head -c 5 | grep -q '%PDF-' && check "the invoice PDF downloads ($(echo "$INVOICE" | field invoiceNumber))"

  # Delivered, so the customer may review it, and the product's rating follows.
  as_shopper -X POST "$BASE/api/v1/products/$PRODUCT_ID/reviews" -d '{"rating":5,"body":"Smoke test review: works as described."}'     | grep -q '"ratingCount":1' && check "the customer reviews the delivered product and its rating updates"

  # The customer cancels the other store's part: its share is reversed and the worker refunds it.
  OTHER_PART="$(as_shopper "$BASE/api/v1/orders/$ORDER_ID" | grep -o '"id":"[a-f0-9]\{24\}","vendor":{"storeName":"Smoke Second Store"' | sed 's/"id":"\([^"]*\)".*/\1/')"
  as_shopper -X POST "$BASE/api/v1/orders/$ORDER_ID/sub-orders/$OTHER_PART/cancel" -d '{"reason":"Smoke test"}' -o /dev/null
  for i in $(seq 1 30); do
    as_shopper "$BASE/api/v1/orders/$ORDER_ID" | grep -q '"refund":{"amount":[0-9]*,"status":"processed"}' && break
    [ "$i" = 30 ] && { echo "✗ the cancelled part was never refunded"; exit 1; }
    sleep 1
  done
  as_shopper "$BASE/api/v1/orders/$ORDER_ID" | grep -q '"status":"partially_refunded"' && check "cancelling a paid part refunds it (after ${i}s)"

  # The dashboards see all of it: the admin's sales and commission, the vendor's paid-out share.
  as_admin "$BASE/api/v1/admin/analytics" | grep -q '"paidOrders":[1-9]' && check "admin analytics counts the paid order"
  as_vendor "$BASE/api/v1/vendor/earnings" | grep -q '"escrow":{"held":[0-9]*,"released":[0-9]*,"paid":[1-9]' && check "the vendor's earnings show the share paid out"
  rm -f "$GUEST_JAR"
fi

echo "Smoke test passed for $BASE"
