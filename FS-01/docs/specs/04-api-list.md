# API list · ShopSphere

[← Database schema](03-database-schema.md) · [Index](../README.md)

Base path `/api/v1`. JSON in and out. Money in **paise**.
Auth: `Authorization: Bearer <access token>`; the refresh token travels in an httpOnly cookie.
Errors always look like `{ "error": { "code": "out_of_stock", "message": "…", "details": { … } } }`.
Lists take `page` and `limit` (max 50) and return `{ items, page, limit, total }`.

Roles: **P** public · **C** customer · **V** vendor (approved unless noted) · **A** admin · **S** signed-in, any role.
The **Day** column says when each endpoint is built; ✓ means it exists now.

## Health

| Method | Path | Role | Purpose | Day |
|---|---|---|---|---|
| GET | `/health` | P | Status of MongoDB, Redis, Elasticsearch and S3; 503 if any is down | ✓ 1 |

## Auth and account

| Method | Path | Role | Purpose | Day |
|---|---|---|---|---|
| POST | `/auth/register` | P | Create a customer or vendor account | ✓ 2 |
| POST | `/auth/login` | P | Email + password → access token + refresh cookie (rate-limited) | ✓ 2 |
| POST | `/auth/refresh` | P (cookie + `X-Requested-With`) | Rotate the refresh token, new access token; reuse of an old token signs the user out everywhere | ✓ 2 |
| POST | `/auth/logout` | P (cookie + `X-Requested-With`) | Revoke this session | ✓ 2 |
| GET | `/auth/me` | S | Current user (a vendor's store status comes from `GET /vendors/me`) | ✓ 2 |
| PATCH | `/account` | S | Change name (addresses on Day 5) | ✓ 2 |
| POST | `/account/password` | S | Change password (other sessions signed out) | ✓ 2 |

## Vendors

| Method | Path | Role | Purpose | Day |
|---|---|---|---|---|
| POST | `/vendors/apply` | V (any status) | Submit or resubmit the store application | ✓ 3 |
| GET | `/vendors/me` | V (any status) | My store and its status (`null` before applying); payout status on Day 6 | ✓ 3 |
| PATCH | `/vendors/me` | V | Edit store details and logo (not while suspended) | ✓ 3 |
| PUT | `/vendors/me/payout` | V | Save payout details (account holder, account number, IFSC); registers the beneficiary with the payout provider and keeps only the last 4 digits | 6 |
| GET | `/stores/:slug` | P | Public store page with products | ✓ 3 |
| GET | `/admin/vendors?status=` | A | Applications and vendors, with owner, product count and counts per status | ✓ 3 |
| POST | `/admin/vendors/:id/approve` · `/reject` · `/suspend` · `/restore` | A | Change vendor status (reject and suspend need a reason) | ✓ 3 |
| PATCH | `/admin/vendors/:id/commission` | A | Set or clear the vendor's commission rate | 8 |

## Categories

| Method | Path | Role | Purpose | Day |
|---|---|---|---|---|
| GET | `/categories` | P | Category tree (cached) | ✓ 3 |
| GET · POST · PATCH · DELETE | `/admin/categories[/:id]` | A | Manage categories (commission rates editable in the UI on Day 8) | ✓ 3 |

## Products and uploads

| Method | Path | Role | Purpose | Day |
|---|---|---|---|---|
| GET | `/products?category=&sort=&page=` | P | Browse active products by category (MongoDB; search moves to Elasticsearch on Day 4) | ✓ 3 |
| GET | `/products/:id` | P | Product page (cached in Redis) | ✓ 3 |
| GET | `/vendor/products` | V | My products, any status, with title search and counts | ✓ 3 |
| GET | `/vendor/products/:id` | V (owner) | One product for the edit form | ✓ 3 |
| POST | `/vendor/products` | V | Create | ✓ 3 |
| PATCH | `/vendor/products/:id` | V (owner) | Edit, change status | ✓ 3 |
| DELETE | `/vendor/products/:id` | V (owner) | Delete (only if never ordered; otherwise set inactive) | ✓ 3 |
| POST | `/uploads/presign` | V | Presigned S3 PUT URL for an image (JPEG/PNG/WebP, ≤ 5 MB) | ✓ 3 |

## Search

| Method | Path | Role | Purpose | Day |
|---|---|---|---|---|
| GET | `/search?q=&category=&brand=&vendor=&minPrice=&maxPrice=&rating=&inStock=&sort=&page=` | P | Full-text search with filters and facet counts; `sort` = `relevance` \| `price_asc` \| `price_desc` \| `rating` \| `newest` | 4 |
| GET | `/search/suggest?q=` | P | Autocomplete (up to 8 titles) | 4 |

## Cart and checkout

| Method | Path | Role | Purpose | Day |
|---|---|---|---|---|
| GET | `/cart` | P | Cart with live prices, stock warnings, grouped by vendor | 5 |
| POST | `/cart/items` | P | Add `{ productId, qty }` | 5 |
| PATCH · DELETE | `/cart/items/:productId` | P | Change quantity or remove | 5 |
| POST · DELETE | `/cart/coupon` | P | Apply or remove a coupon | 7 |
| POST | `/checkout` | C | Create order + sub-orders, reserve stock, create the Razorpay order | 5 / 6 |
| POST | `/checkout/verify` | C | Verify the payment signature returned by the popup | 6 |
| POST | `/webhooks/razorpay` | P (signed) | Payment and refund events; HMAC-verified, idempotent | 6 |
| POST | `/webhooks/payouts` | P (signed) | Payout events from the payout provider (the simulated one in v1); HMAC-verified, idempotent | 6 |

Guests are identified by an httpOnly `guest_id` cookie; their cart merges into the account on login.

## Orders

| Method | Path | Role | Purpose | Day |
|---|---|---|---|---|
| GET | `/orders` · `/orders/:id` | C | My orders with each vendor's part and timeline | 5 |
| POST | `/orders/:id/sub-orders/:subId/cancel` | C | Cancel a part that hasn't shipped | 5 / 6 |
| GET | `/vendor/orders?status=` | V | My sub-orders | 5 |
| POST | `/vendor/orders/:subId/status` | V | `{ status: "packed" \| "shipped" \| "delivered", tracking? }` | 5 |
| GET | `/invoices/:subId` | C (buyer) · V (seller) · A | Short-lived download link for the PDF | 7 |

## Reviews

| Method | Path | Role | Purpose | Day |
|---|---|---|---|---|
| GET | `/products/:id/reviews` | P | Visible reviews, newest first | 7 |
| POST | `/products/:id/reviews` | C | Review after delivery, once per product | 7 |
| PATCH | `/admin/reviews/:id` | A | Hide or show | 7 |

## Coupons

| Method | Path | Role | Purpose | Day |
|---|---|---|---|---|
| GET · POST · PATCH | `/vendor/coupons[/:id]` | V | My store's coupons | 7 |
| GET · POST · PATCH | `/admin/coupons[/:id]` | A | Platform coupons | 7 |

## Earnings, analytics and refunds

| Method | Path | Role | Purpose | Day |
|---|---|---|---|---|
| GET | `/vendor/earnings?from=&to=` | V | Held, released and paid-out totals, commission, per sub-order list | 8 |
| GET | `/admin/analytics?from=&to=` | A | GMV, commission, orders by status, daily sales, top vendors and products | 8 |
| POST | `/admin/sub-orders/:subId/refund` | A | Cancel and refund a part of an order | 8 |

## Common error codes

| HTTP | code | When |
|---|---|---|
| 400 | `validation_error`, `invalid_json` | Bad input (Zod details in `details`) |
| 401 | `unauthenticated`, `token_expired`, `session_ended`, `session_reused`, `invalid_credentials` | Not signed in, token expired (refresh), session revoked, stolen refresh token detected, wrong email or password |
| 403 | `forbidden`, `vendor_not_approved`, `account_suspended`, `csrf_header_missing` | Wrong role (with `requiredRoles`), not the owner, store not approved, suspended account, cookie endpoint without the header |
| 404 | `not_found` | Unknown id or route |
| 409 | `email_taken`, `refresh_in_progress`, `already_applied`, `invalid_transition`, `sku_taken`, `category_in_use`, `product_has_orders`, `out_of_stock`, `price_changed`, `already_reviewed`, `coupon_exhausted` | State conflicts |
| 413 | `payload_too_large` | Body over 100 kB |
| 429 | `rate_limited` | Too many attempts |
| 503 | (health) | A backing service is down |

Request and response examples for everything built so far: [API reference](../06-api-reference.md). The full machine-readable reference will be `docs/openapi.yaml` (Day 10).
