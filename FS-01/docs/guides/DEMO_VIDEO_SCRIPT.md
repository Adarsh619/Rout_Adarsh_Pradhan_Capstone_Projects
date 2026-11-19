# Demo video script · ShopSphere (about 6 minutes)

[Index](../README.md) · [Presentation outline](PRESENTATION.md) · [Day plan](DAY_PLAN.md)

A shot-by-shot script for the screen recording that goes with the submission. Each scene says what to click and what
to say; put the words into your own voice. Record in one take per scene and join them, or in one go with pauses.

## Before you record (10 minutes)

1. **Browser:** Chrome or Edge, window about 1280 × 800, zoom 100%, bookmarks bar hidden, no other tabs with personal
   data. Use a fresh profile or a private window so no saved logins or autofill pop up.
2. **Three tabs**, each signed in on the live site https://shopsphere-fs01.vercel.app (one private window per account):
   - **Customer:** `customer@shopsphere.test`
   - **Vendor:** `vendor@shopsphere.test` (Vikram Electronics)
   - **Admin:** `admin@shopsphere.test`
   Type the live demo password yourself; never show it on screen (the eye button stays closed).
3. **Empty the customer's cart** first.
4. **Recorder:** OBS Studio or the Windows Game Bar (Win + G), 1080p, microphone on, notifications off (Focus assist).
5. **Razorpay test payment:** Netbanking → any bank → **Success**. No real money moves.

## Scenes

| # | Time | Screen | Do | Say |
|---|---|---|---|---|
| 1 | 0:00–0:25 | Home page | Scroll slowly from the banner to the product grid | "This is ShopSphere, a multi-vendor marketplace I built: many stores sell, customers buy from several in one checkout, and the platform splits the payment and keeps a commission. It's live on Vercel, with the API on AWS." |
| 2 | 0:25–0:55 | Search | Type **iphne** (typo) in the search box; show the suggestions; press Enter; tick a brand filter, then sort by price | "Search runs on Elasticsearch: it fixes my typo, suggests as I type, and the filters show how many products each one has." |
| 3 | 0:55–1:25 | Product page → cart | Open **Apple iPhone Charger** (Vikram Electronics), Add to cart; search **lipstick**, add **Red Lipstick** (Daily Fresh & Care); open the cart | "One cart, two different stores. Prices and stock are always re-checked; the cart lives in Redis." |
| 4 | 1:25–1:45 | Cart | Type **WELCOME10**, Apply | "A platform coupon: ten percent off, capped at two hundred rupees. The platform pays for it, so the stores still get their full share." |
| 5 | 1:45–2:35 | Checkout → Razorpay | Proceed to checkout, pick or add an address, **Place order and pay**; in Razorpay choose Netbanking → a bank → Success | "One order, two parts, one for each store. The stock is held for fifteen minutes while I pay. This is Razorpay in test mode, so no real money moves." |
| 6 | 2:35–3:05 | Order page | Show the two parts, the timeline, then the invoice links appearing | "The payment is confirmed: the signature is checked, and Razorpay's webhook confirms it too, but only once. Each store ships its own part, and each gets a PDF invoice made in the background." |
| 7 | 3:05–3:55 | Vendor tab → Orders to ship | Find the new order; **Mark as packed** → **Mark as shipped** (courier BlueDart, any tracking number) → **Mark as delivered**; point at "Payout" changing from held to paid | "As the store, I see only my part, what I earn after the ten percent commission, and that my share is held until delivery. When I mark it delivered, the share is released and paid out (simulated payouts)." |
| 8 | 3:55–4:20 | Customer tab → order page | Refresh; cancel the **Daily Fresh & Care** part with a reason | "The customer can cancel one store's part before it ships. Only that part is refunded, and the store's share and the commission are reversed in the ledger." |
| 9 | 4:20–4:55 | Admin tab → Analytics | Show the totals, the daily chart, top stores | "Admins see sales, commission and every rupee still held for stores, all computed from an append-only ledger that always balances." |
| 10 | 4:55–5:20 | Admin → Orders and refunds, Vendors | Search the order number; open Vendors and show **Kavya Handicrafts** waiting for approval | "Support can find any order and refund a part, and new stores wait for approval before they can sell." |
| 11 | 5:20–5:50 | GitHub repo | Show the README, the green CI badge, the docs folder, the ShopSphere v1.0.0 release | "Everything is on GitHub: 266 automated tests run on every push, the server deploys itself only after they pass, and fourteen docs explain the design." |
| 12 | 5:50–6:00 | Home page | Back to the shop | "That's ShopSphere. Thank you for watching." |

## After recording

1. Watch it once; check the password never appears and nothing personal is on screen.
2. Upload to the submission's Google Drive folder, then **Share → General access → Anyone with the link → Viewer**.
3. Copy the link for the submission form.
4. The nightly reset at 03:00 IST removes the test order, so the live demo stays clean.

**If something fails while recording:** Razorpay unreachable → use scene 5 again later; a page loads slowly → pause the
recording and resume. The local copy (`docker compose up`, mock payments) can stand in, but the live site is better
for the submission.
