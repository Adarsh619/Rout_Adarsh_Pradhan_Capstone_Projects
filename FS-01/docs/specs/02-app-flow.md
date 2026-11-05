# App flow · ShopSphere

[← PRD](01-prd.md) · [Index](../README.md) · [Next: Database schema →](03-database-schema.md)

## 1. Screen map

| Area | Screens | Who |
|---|---|---|
| Public | Home, search results, product page, store page, cart, sign in, register | Everyone |
| Customer | Checkout, my orders, order detail (timeline per vendor), invoices, write review, account | Customer |
| Vendor | Application form / status, dashboard, products (list, create, edit, photos), orders, earnings, payout setup, coupons | Vendor |
| Admin | Dashboard (analytics), vendors (approve / suspend / commission), categories, coupons, reviews, refunds | Admin |

## 2. Vendor onboarding

```mermaid
flowchart LR
  A[Register as vendor] --> B[Submit store application]
  B --> C{Admin review}
  C -- reject --> D[Rejected, with reason<br/>can re-apply]
  C -- approve --> E[Approved]
  E --> F[Payout details<br/>bank account + IFSC]
  F --> G[List products]
  E -. admin suspends .-> H[Suspended<br/>products hidden]
  H -. admin restores .-> E
```

A vendor can list products as soon as they are approved, but **released earnings can't be paid out until payout details are added**, so the dashboard keeps reminding them.

## 3. Buying journey

```mermaid
sequenceDiagram
  actor C as Customer
  participant UI as React app
  participant API as API
  participant RZ as Razorpay
  C->>UI: Search, add items from vendors A and B
  UI->>API: POST /cart/items (Redis cart)
  C->>UI: Checkout (address, coupon)
  UI->>API: POST /checkout
  API->>API: Re-check prices and stock, one transaction:<br/>order + sub-order A + sub-order B, stock reserved
  API->>RZ: Create order (grand total in paise)
  API-->>UI: Razorpay order id
  UI->>RZ: Checkout popup (UPI success@razorpay)
  RZ-->>UI: payment id + signature
  UI->>API: POST /checkout/verify
  RZ-->>API: Webhook payment.captured (signed)
  API->>API: Mark paid (once); ledger: payment, commission,<br/>vendor A share held, vendor B share held
  API-->>UI: Order confirmed
```

The payment is real Razorpay (test mode). Vendor shares are held in the platform's own ledger, not at Razorpay (see [design decision 1](../04-design-decisions.md#1-real-razorpay-payments-our-own-split-and-escrow-engine)).

If the customer never pays, the reservation expires after 15 minutes, the stock goes back and the order becomes `expired`.

## 4. Sub-order lifecycle (one per vendor)

```mermaid
stateDiagram-v2
  [*] --> awaiting_payment: checkout (stock reserved)
  awaiting_payment --> placed: payment verified
  awaiting_payment --> cancelled: not paid in 15 min, or customer cancels
  placed --> packed: vendor
  packed --> shipped: vendor adds tracking no.
  shipped --> delivered: vendor (or admin)
  placed --> cancelled: customer, vendor or admin
  packed --> cancelled: customer, vendor or admin
  delivered --> [*]
  cancelled --> [*]
```

| Event | Money |
|---|---|
| `placed` | Vendor's share (minus commission) **held** in the ledger |
| `delivered` | Share **released**; a `payout` job pays it out through the `PayoutProvider` (simulated in v1) and it shows as **paid out** |
| `cancelled` | Held share **reversed**, that part of the payment **refunded** to the customer through Razorpay, stock returned |

Only allowed moves are accepted; for example a shipped sub-order can't be cancelled, and nothing moves backwards.

## 5. Coupon at checkout

1. Customer enters a code in the cart.
2. API checks: active, within dates, minimum order met, total and per-user limits, and for a vendor coupon that the cart has that vendor's items.
3. Discount shown; applied for real only inside the checkout transaction (so two tabs can't both use the last redemption).

## 6. Review

Only shown for products in a **delivered** sub-order of that customer, once per product. The product's average rating updates straight away and the search index shortly after.

## 7. Access by role

| Action | Guest | Customer | Vendor | Admin |
|---|:-:|:-:|:-:|:-:|
| Browse, search, cart | ✓ | ✓ | ✓ | ✓ |
| Checkout, orders, reviews | | ✓ | | |
| Manage own products, orders, earnings | | | ✓ (approved) | |
| Approve vendors, commission, categories, refunds, analytics | | | | ✓ |
