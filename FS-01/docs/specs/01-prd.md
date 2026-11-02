# Product Requirements Document (PRD) · ShopSphere

[Index](../README.md) · [Next: App flow →](02-app-flow.md)

| | |
|---|---|
| Product | ShopSphere: multi-vendor e-commerce marketplace |
| Project ID | FS-01 |
| Author | Rout Adarsh Pradhan |
| Status | Day 1: specs and scaffold |
| Last updated | 2 Nov 2026 |

## 1. Problem

Small sellers can't afford their own online store, payment gateway and search. Buyers don't want to visit twenty sites to compare products.
A **marketplace** solves both: many vendors list products in one place, customers search everything at once, fill **one cart from many sellers** and pay **once**.
The platform must then **split that single payment** between the vendors and keep a **commission** for itself, which is the hard part.

## 2. Goals and non-goals

| Goals | Non-goals (v1) |
|---|---|
| Vendors apply, get approved and sell their own products with photos | Live money (Razorpay **test mode** only) |
| Customers find products fast with typo-tolerant search, filters and sorting | Shipping-carrier integration (vendor types the tracking number) |
| One checkout for items from several vendors, paid with UPI or card | Product variants (size/colour); each variant is its own product |
| Every vendor is paid their share minus commission, **only after delivery** | Returns after delivery, chat between buyer and seller |
| Each order moves through placed → packed → shipped → delivered | Native mobile apps, multiple currencies (INR only) |
| Reviews, coupons, PDF invoices and an admin analytics dashboard | Recommendation engine, ads for sellers |
| Frontend and backend deployed separately and reachable 24/7 | Multi-region hosting |

## 3. Personas

| Persona | Wants | Pain today |
|---|---|---|
| **Priya, customer** | Find a good product at a fair price, pay by UPI, know when it arrives | Jumping between sites, unclear delivery status |
| **Ravi, vendor** (small electronics shop) | Sell online without building a website; get paid reliably | No tech team, worried about payment disputes |
| **Anita, platform admin** | Keep sellers trustworthy, earn commission, see how the business is doing | Manual spreadsheets for payouts and sales |

## 4. User stories

### Customer
1. As a customer I can **register and sign in** with email and password.
2. I can **search** products by keyword (even misspelt) and **filter** by category, brand, price, rating, seller and availability, and **sort** by relevance, price, rating or newest.
3. I can add items from **different vendors to one cart**, as a guest too; my guest cart is kept when I sign in.
4. I can apply a **coupon** and see the discount before paying.
5. I can **pay once** with UPI, card or netbanking (test mode).
6. I can follow each part of my order (one per vendor) from **placed to delivered**, and **cancel** a part before it ships.
7. I can **download a PDF invoice** for each part of my order.
8. I can **review** a product I bought after it is delivered.

### Vendor
9. As a vendor I can **apply** with my store details and see whether I'm approved.
10. Once approved I can set up **payouts** (Razorpay linked account).
11. I can **create, edit, hide and delete** my products and **upload photos**.
12. I see only **my** part of each order and move it to **packed, shipped** (with tracking number) and **delivered**.
13. I see my **earnings**: held, released and settled amounts, and the commission taken.
14. I can create **coupons** for my own store.

### Admin
15. As an admin I can **approve, reject or suspend** vendors.
16. I can manage **categories** and set **commission** rates (platform default, per category, per vendor).
17. I can create **platform-wide coupons**, hide abusive **reviews** and issue **refunds**.
18. I can see **analytics**: total sales (GMV), commission earned, orders by status, daily sales, top vendors and products.

## 5. Functional requirements

| Area | Requirement |
|---|---|
| Auth | Email + password (bcrypt); short-lived access JWT; rotating refresh token in an httpOnly cookie, stored in Redis so logout revokes it; role checked on every protected route |
| Vendors | Status `pending → approved / rejected`, `approved ↔ suspended`; suspended vendors' products disappear from search |
| Products | Owned by one vendor; price, MRP, stock, category, brand, up to 6 images on S3; `draft / active / inactive`; money stored in **paise** (integers) |
| Search | Elasticsearch: fuzzy full-text, filters, facet counts, 4 sort orders, autocomplete; index kept in sync by a background job |
| Cart | Redis; guest carts merge on login; prices and stock re-checked at checkout |
| Orders | One **order** per checkout, split into one **sub-order per vendor**; stock reserved at checkout and released if unpaid in 15 min |
| Lifecycle | Sub-order `placed → packed → shipped → delivered`, or `cancelled` before shipping; every change recorded with who and when |
| Payments | Razorpay order for the full amount; signature-verified webhooks, idempotent; one **on-hold transfer per vendor** (their share minus commission), released on delivery, reversed on cancellation |
| Commission | Basis points (1000 = 10%); vendor rate overrides category rate, which overrides the platform default |
| Coupons | Platform or vendor scope; percent (with cap) or flat; min order, date window, total and per-user limits |
| Reviews | Only after delivery, one per customer per product; updates the product's average rating (and search) |
| Invoices | PDF per sub-order, generated in the background, stored privately on S3, downloaded through a short-lived link |
| Analytics | Admin: GMV, commission, orders by status, daily sales, top vendors/products. Vendor: earnings |

## 6. Non-functional requirements

| Area | Target |
|---|---|
| Performance | Search p95 < 200 ms with 20 000 products; cached product page p95 < 50 ms |
| Correctness | No overselling under parallel checkouts; money sums always balance (customer paid = vendor transfers + platform share) |
| Security | OWASP basics: hashed passwords, rate-limited login, role and ownership checks, input validation, signed webhooks, private S3 bucket |
| Availability | Live demo answers 24/7 without cold starts |
| Quality | Lint + tests in CI on every push; Docker smoke test |
| Docs | One numbered doc per topic, architecture and ER diagrams, API reference |

## 7. Success metrics for the demo

- A full journey works end to end: vendor approved → product listed → found in search → bought together with another vendor's product → paid by UPI → shipped → delivered → vendor's money released → reviewed.
- Ledger check: for every paid order, `customer paid = Σ vendor transfers + platform commission − platform coupon discount`.
- CI green; test and performance numbers recorded in the docs.
