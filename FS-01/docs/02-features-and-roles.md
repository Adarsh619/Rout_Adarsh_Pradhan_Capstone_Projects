# 02 · Features and roles

[← Overview](01-overview.md) · [Index](README.md) · [Next: System architecture →](03-architecture.md)

## Roles

Every account has exactly one role. Sign-up creates **customers** or **vendors**; **admins** are created by the seed script only.

| Role | In one line |
|---|---|
| **Customer** | Finds products, buys from several vendors in one checkout, tracks, reviews |
| **Vendor** | Runs one store: products, photos, its share of orders, earnings |
| **Admin** | Runs the platform: approves vendors, sets commission, coupons, refunds, analytics |
| *Guest* (not signed in) | Browses, searches and fills a cart; signs in to check out |

## Features by role

### Customer
- Search with typo tolerance, filters (category, brand, price, rating, seller, in stock), sorting and autocomplete.
- One cart for many vendors, grouped by vendor; a guest cart is kept on sign-in.
- Coupons, one payment by UPI / card / netbanking (Razorpay test mode).
- Order page with a timeline for each vendor's part: placed → packed → shipped → delivered.
- Cancel a part that hasn't shipped and get that part refunded.
- PDF invoice per vendor; reviews after delivery.

### Vendor
- Store application, then admin approval; payout details (bank account + IFSC, only the last 4 digits stored).
- Products: create, edit, hide, delete; up to 6 photos uploaded straight to S3.
- Orders: only their own part of each order; mark packed, shipped (with tracking number) and delivered.
- Earnings: held (until delivery), released and paid out, after commission. Payouts are simulated in v1 and labelled so.
- Coupons for their own store.

### Admin
- Approve, reject, suspend and restore vendors; suspended stores vanish from search.
- Categories and commission: platform default 10%, overridable per category and per vendor.
- Platform coupons, review moderation, refunds.
- Analytics: GMV, commission earned, orders by status, daily sales, top vendors and products.

## Permission rules

1. Every protected endpoint checks the **role** first, then **ownership**: a vendor can only touch their own products and sub-orders, a customer only their own orders.
2. A vendor whose store isn't `approved` can sign in and see their application, but can't list products or receive orders.
3. Prices, stock and coupon validity are always taken from the server, never from the browser.

The full access table is in the [app flow](specs/02-app-flow.md#7-access-by-role).
