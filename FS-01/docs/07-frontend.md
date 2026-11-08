# 07 · Frontend

[← API reference](06-api-reference.md) · [Index](README.md) · [Next: Background jobs and search →](08-background-jobs.md)

A single-page React app in `frontend/`, served by nginx locally and by Vercel on the live site. It talks to the API
only; it never holds a secret, and everything it shows comes from the server.

| | Choice |
|---|---|
| Framework | React 19 + TypeScript, built with Vite |
| Routing | React Router 7, one `<Routes>` table in `App.tsx` |
| Server data | TanStack Query 5: caching, background refetch, `placeholderData` so lists don't flash while paging |
| Styling | Tailwind CSS 4 with a small brand palette (`--color-brand-*` in `index.css`) |
| Tests | Vitest + Testing Library (jsdom); the API is faked at `fetch` with `mockApi` |

## Folder layout

| Folder | What's in it |
|---|---|
| `src/api/` | One file per area (`catalog`, `cart`, `orders`, `reviews`, `coupons`, `analytics`, …): types for the API's answers, `useX` query hooks and plain functions for actions. `client.ts` is the only place that calls `fetch` |
| `src/auth/` | `AuthContext` (who is signed in), `RequireAuth` (guards a page by role) |
| `src/pages/` | One component per screen; `vendor/` and `admin/` for the dashboards |
| `src/components/` | Shared pieces: layout and header, product cards and prices, form fields, the search box, the order timeline, reviews, the invoice button, the column chart, the commission editor |
| `src/lib/` | `money.ts` (paise ↔ rupees, `₹` formatting), `razorpay.ts` (loads Razorpay's popup only when someone pays) |
| `src/test/` | `render.tsx` (renders with every provider, `mockApi`, fixtures), `setup.ts` |

## Screens by role

| Role | Pages |
|---|---|
| Everyone | Home (departments), search with filters, product page (photos, specs, reviews), store page, cart (guests too) |
| Customer | Checkout (addresses, review, pay), payment (Razorpay popup or the test screen), my orders, order page (each store's progress, cancel a part, invoice, review), account |
| Vendor | Dashboard (store status, payout account), products and the product editor (photo uploads straight to S3), orders to ship, coupons, earnings |
| Admin | Dashboard, analytics, orders and refunds, vendors (approve / suspend, commission rate), categories (commission rate), coupons, reviews |

A page meant for another role explains which account type it's for instead of showing a blank page; signed-out
visitors are sent to sign in and brought back afterwards (`?next=`, same-site paths only).

## How state is handled

| State | Where it lives | Notes |
|---|---|---|
| Who is signed in | `AuthContext` | The access token is kept **in memory only**; on page load the httpOnly refresh cookie restores the session |
| Anything from the API | TanStack Query cache | Keys like `["orders", id]`; an action updates the cache with the server's answer (`setQueryData`) or invalidates the right keys |
| The cart | Query key `["cart", userId \| "guest"]` | Every cart change answers with the whole cart, which replaces the cached one; signing in switches to the account's cart, already merged by the server |
| Search filters, admin tabs, page numbers | The URL (`useSearchParams`) | Shareable, and Back works |
| Form input | Component state | Field errors come straight from the API's `details.fields` |

**The API client** (`api/client.ts`) adds the `Authorization` header and `X-Requested-With: ShopSphere`, sends cookies,
and turns error answers into an `ApiError` carrying the `code` and the per-field messages. When the access token
expires it refreshes once (one shared refresh for every request waiting on it) and retries; if the session is gone it
signs the user out.

**Money** is integer paise everywhere; `formatINR` turns it into `₹1,999` or `₹1,999.50`, `formatCompactINR` into
`₹21.3K` / `₹2.5L` for chart axes, and `parseRupees` turns what a vendor types back into paise.

## Payments in the browser

`OrderPage` shows the payment panel while an order waits for payment:

- **Razorpay** (`provider: "razorpay"`): `lib/razorpay.ts` loads `checkout.js` on demand and opens the popup with the
  public key id, the Razorpay order and the amount; its signed result goes to `/checkout/verify`. A failure inside the
  popup is shown and the customer can try again.
- **Mock** (local and CI): a test screen with Pay / Simulate a failure / Cancel. The server signs the "payment" like
  Razorpay would, and the same verification runs.

A countdown shows how long the stock stays reserved.

## Charts

The analytics and earnings pages use one small SVG component, `ColumnChart`, instead of a chart library:

- one value per day, thin columns (≤ 24px) with 4px rounded tops on a single baseline, a quiet grid, ₹ axis labels
- the peak day is labelled; every other value is in a tooltip on hover or keyboard focus (each day's whole slot is the
  target, bigger than the bar)
- **Show as table** gives the same numbers as an accessible table
- one series, so no legend; the brand indigo was checked for lightness, chroma and 3:1 contrast on the page background

Status counts use simple labelled bars; headline figures are `StatTile`s. Ranges (7 / 30 / 90 days) are in one row
above the charts and are computed in Indian time, like the API's.

## Loading, empty and error states

Every page that loads data shows **Loading…** first, a clear sentence when there's nothing yet ("You haven't ordered
anything yet", "No orders with this status", "Nothing in this period"), and an error page that tells a 404 apart from
a connection problem. Buttons are disabled and relabelled while an action runs ("Placing your order…"), and an
action's error is shown next to it (`role="alert"`).

## Phones and accessibility

- Layouts are single-column on phones and grow with `sm:` / `lg:` breakpoints; the header puts the search box on its
  own row. Checked at 375px wide: no page scrolls sideways (wide tables scroll inside their own box).
- New pages open at the top; Back and Forward keep the browser's scroll position.
- Labels on every input, `aria-invalid` and messages linked to fields, real buttons and links, tab lists and pressed
  states announced, the cart count in the link's name, an ARIA combobox for search suggestions, status messages in
  `role="status"`.

## Tests

`npm test` runs 62 tests in 8 files. Each page test renders the real `App` at a URL with `mockApi` answering the
calls it expects (an unexpected call fails the test) and drives it like a user with `user-event`:

| File | Covers |
|---|---|
| `App.test.tsx`, `auth/auth.test.tsx` | Sign-in, sign-up, sessions, role guards |
| `pages/catalog.test.tsx`, `search.test.tsx` | Browsing, product page, store application, product editor, search, filters, suggestions |
| `pages/orders.test.tsx`, `payments.test.tsx` | Cart, checkout, payment (mock and Razorpay popup), order tracking, vendor orders, payout account |
| `pages/extras.test.tsx` | Coupons in the cart, reviews, coupon management, invoice download |
| `pages/admin.test.tsx` | Analytics and its table view, vendor earnings, orders and refunds, commission rates |

Page tests type into forms, which is slow in jsdom when many files run in parallel, so the per-test timeout is 15 s.
