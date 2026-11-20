# Individual reflection · guide

[Index](../README.md) · [Presentation outline](PRESENTATION.md) · [Day plan](DAY_PLAN.md)

> The finished reflection is [REFLECTION.md](REFLECTION.md).

The brief asks for an **individual reflection from each intern on what they learned and what they owned**. This page
gives a structure, questions to answer and the facts you can draw on. The reflection itself must be **in your own
words**: reviewers read it to hear you, so write it yourself, then check it against the facts below.

**Length:** about one page (500–700 words). **Tone:** first person, honest, specific. One real example beats three
general claims.

## Structure

### 1. The project in two sentences
What ShopSphere is and why it was a hard problem (one payment split between several stores, held until delivery).

### 2. What I owned
Be concrete about your part and how you worked. Questions to answer:
- Which decisions did you make? (e.g. Razorpay test mode + your own ledger when Route wasn't available; AWS when Oracle
  had no capacity; Forest green + coral; accepting the move to PostgreSQL + Prisma.)
- What did you set up and run yourself? (AWS account, EC2 server, security group, S3 bucket and IAM role, DuckDNS,
  Razorpay test account and webhook, Vercel, UptimeRobot, the server's `.env`, seeding the live site, branch
  protection, test purchases.)
- How did you use tools, including AI assistants? Say it plainly: what you asked for, what you checked, what you
  decided or changed. Reviewers value an honest account of how the work was done.

### 3. What I learned (pick 3, each with an example)
Ideas to choose from; write the ones that are true for you:
- **Money needs its own rules:** integer paise, an append-only ledger, a balance check after every scenario.
- **Design for the unhappy paths:** two buyers for one item, the same payment reported twice, refunds the provider
  refuses, a customer who closes the tab.
- **Tests make big changes safe:** the database moved from MongoDB to PostgreSQL in a day because the same tests had
  to pass before and after.
- **Deployment is part of the product:** HTTPS, cookies across domains (the Vercel `/api` rewrite), no keys on the
  server (IAM role), auto-deploy only after CI passes, a nightly reset for a shared demo.
- **Working with a changing brief and limits:** Oracle capacity, Razorpay test-account limits, the tech stack change
  three days before the deadline.

### 4. What was hardest, and how I handled it
One challenge in more detail: what went wrong, what you tried, what worked. (See
[Challenges and next steps](../13-challenges-and-next-steps.md) for the full list.)

### 5. What I'd do differently
One or two honest points, e.g. confirm the required stack before building; set up the live server earlier; add
browser tests (Playwright) and a larger load test.

### 6. What I'd build next
Real payouts with Razorpay Route, email notifications, GST and shipping, a 20,000-product load test.

## Facts you can use

| | |
|---|---|
| Live | https://shopsphere-fs01.vercel.app (Vercel) · API on AWS EC2, Mumbai |
| Stack | React 19, Tailwind, Node 24, Express 5, TypeScript, PostgreSQL 17 + Prisma 7, Redis, BullMQ, Elasticsearch, S3, Razorpay test mode, Docker, GitHub Actions |
| Tests | 266 automated (97 unit, 104 integration, 65 frontend) + an end-to-end smoke test; backend coverage 93.5% |
| Load test | 50 shoppers on the live site: 0 errors in 5,403 requests, p95 110 ms |
| Timeline | Live backend 14 Nov · Vercel frontend 16–17 Nov · brief changed to PostgreSQL + Prisma 17 Nov, migrated and live the same day · bug sweep, docs and release 17–19 Nov |
| Docs | 14 topic docs, OpenAPI 3.1 spec, release ShopSphere v1.0.0 |

## Before you hand it in
- Read it aloud once; cut any sentence that doesn't sound like you.
- Every claim matches the facts above (numbers, dates, what you did).
- No passwords, keys or private links in it.
