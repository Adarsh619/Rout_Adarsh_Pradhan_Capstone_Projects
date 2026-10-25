# Accounts & Setup Checklist

## Zero-cost guarantee
Everything this project needs works on free tiers. **You never need to enter a credit card.**

- **Stripe**: the default **mock mode** needs no Stripe account at all (Stripe is invite-only in India). If you later get real Stripe access, use **Test mode** only (`sk_test_...` keys); it never moves real money.
- **Docker Desktop**: free for personal, education and small-business use.
- **GitHub + Actions + Container Registry**: free for public repositories. Private repos get 2,000 free Actions minutes per month; this pipeline uses about 5 minutes per push.
- **Deployment is optional**: the deliverable says "deployed *or* screen-recorded". Record the demo running locally with `docker compose up` (Windows: Win+Alt+R with Xbox Game Bar, or OBS Studio). That costs nothing.
  If you do deploy, only use free instance types and never add a payment method. Free hosting tiers can sleep, expire (e.g. Render's free Postgres expires after 30 days) or lack background workers, so a local recording is the safer option.
- Leave the `BACKEND_DEPLOY_HOOK` / `FRONTEND_DEPLOY_HOOK` secrets unset and the CI deploy step skips itself.

| # | Account / tool | Needed for | Required? | Cost |
|---|---|---|---|---|
| 1 | **GitHub** account + new empty repo | Code hosting, GitHub Actions CI, GHCR images | Yes | Free |
| 2 | **Git** + **VS Code** | Daily commits, editing | Yes | Free |
| 3 | **Docker Desktop** (Windows: enable WSL 2) | `docker compose up` for the full stack | Yes | Free for personal / education use. Docker Hub account optional (only for `docker login`). |
| 4 | **Stripe** account in *Test mode* + **Stripe CLI** | Real hosted Stripe Checkout | **No.** Mock mode (default) covers billing without an account | Free, no real charges |
| 5 | Python 3.12+ and Node 20+ | Running without Docker, VS Code test explorer | Recommended | Free |
| 6 | **Render** (or similar) | Public deployed demo + auto-deploy from CI | **Optional, skip it**: a screen recording satisfies the deliverable | Free tier only, no card |
| 7 | webhook.site | Watching outgoing webhooks arrive during the demo | Optional | Free, no signup |

## Stripe mock mode (default, no account)

Nothing to set up: `.env.example` has `STRIPE_MOCK=true`, and `docker compose up` starts the `stripe-mock` container.
In the app, open **Billing → Upgrade**, then **Subscribe** on the simulated checkout page. The plan switches to Pro and the limits rise.
**Manage subscription** lets you change plan or cancel.

## Stripe test-mode setup (optional, needs a Stripe account)

Set `STRIPE_MOCK=false` in `.env`, then:

1. Sign up at stripe.com and make sure the **Test mode** toggle is on. You don't need to activate payments.
2. **Product catalog → Add product**:
   - "TaskFlow Pro", recurring, $10/month → copy the price ID `price_...` into `STRIPE_PRICE_PRO`
   - "TaskFlow Business", recurring, $25/month → `STRIPE_PRICE_BUSINESS`
3. **Developers → API keys** → copy the secret key `sk_test_...` into `STRIPE_SECRET_KEY`.
4. **Settings → Billing → Customer portal** → click *Activate test link* (this lets "Manage subscription" work).
5. Webhooks during local development: install the Stripe CLI, then
   ```bash
   stripe login
   stripe listen --forward-to localhost:8000/api/billing/stripe-webhook/
   ```
   Copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET`.
   For a deployed app, add an endpoint in Developers → Webhooks for `https://<your-api>/api/billing/stripe-webhook/` with the events
   `checkout.session.completed`, `customer.subscription.created/updated/deleted` and `invoice.payment_failed`.
6. Restart the backend. Test card: `4242 4242 4242 4242`, any future expiry, any CVC.

Never commit real keys. `.env` is in `.gitignore`.

## GitHub repository settings

- Actions are on by default. The `docker` job pushes to `ghcr.io/<you>/<repo>-backend` / `-frontend` using the built-in `GITHUB_TOKEN`; nothing to set up.
- Optional deploy: create Render services from those images (or from the repo's Dockerfiles), copy each service's **Deploy Hook URL**, and add them as
  repository secrets `BACKEND_DEPLOY_HOOK` and `FRONTEND_DEPLOY_HOOK` (Settings → Secrets and variables → Actions). Create an environment called `production`.
- Render also needs a PostgreSQL database and a Redis (Key Value) instance; set `DATABASE_URL`, `REDIS_URL`, `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=false`,
  `DJANGO_ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`, `FRONTEND_URL`, `RUN_MIGRATIONS=1` and the Stripe variables on the backend service.
