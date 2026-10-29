"""Thin wrapper around Stripe Billing (test mode or stripe-mock).

Stripe sends webhooks at least once and in no guaranteed order, so the handler:
- records an event as processed in the same transaction that applies it (a failure rolls both back,
  and Stripe's retry is applied rather than skipped as a duplicate);
- ignores events about a subscription other than the workspace's current one, and events older than
  the last one applied (a late "deleted" for an old subscription can't downgrade a paying workspace);
- writes a "billing.stripe_update" audit entry whenever an event changes the plan or status.
"""
import json
import logging
from datetime import datetime, timezone

import stripe
from django.conf import settings
from django.db import IntegrityError, transaction
from rest_framework.exceptions import APIException, ValidationError

from apps.audit.services import record_system

from .models import StripeEvent, Subscription
from .plans import plan_for_price, price_id

logger = logging.getLogger(__name__)

# A workspace in one of these states already pays (or is about to): a second checkout would bill twice.
LIVE_STATUSES = {Subscription.Status.ACTIVE, Subscription.Status.TRIALING, Subscription.Status.PAST_DUE}


class StripeNotConfigured(APIException):
    status_code = 503
    default_detail = "Stripe is not configured. Set STRIPE_SECRET_KEY and price IDs in .env (test mode keys)."


def _client():
    if not settings.STRIPE_SECRET_KEY:
        raise StripeNotConfigured()
    stripe.api_key = settings.STRIPE_SECRET_KEY
    if settings.STRIPE_MOCK:
        stripe.api_base = settings.STRIPE_API_BASE  # Stripe's official mock server
    return stripe


def ensure_customer(sub, email):
    s = _client()
    if not sub.stripe_customer_id:
        customer = s.Customer.create(email=email, name=sub.workspace.name, metadata={"workspace_id": sub.workspace_id})
        sub.stripe_customer_id = customer["id"]
        sub.save(update_fields=["stripe_customer_id"])
    return sub.stripe_customer_id


@transaction.atomic
def create_checkout_session(workspace, plan, user):
    # Locked so two quick Upgrade clicks can't create two Stripe customers.
    sub = Subscription.objects.select_for_update().select_related("workspace").get(workspace=workspace)
    if sub.stripe_subscription_id and sub.status in LIVE_STATUSES:
        raise ValidationError("This workspace already has a subscription. Use Manage subscription to change plans.")
    price = price_id(plan)
    if not price:
        raise StripeNotConfigured(f"No Stripe price configured for plan '{plan}'.")
    customer = ensure_customer(sub, user.email)
    session = _client().checkout.Session.create(
        mode="subscription",
        customer=customer,
        line_items=[{"price": price, "quantity": 1}],
        success_url=f"{settings.FRONTEND_URL}/w/{workspace.slug}/billing?checkout=success",
        cancel_url=f"{settings.FRONTEND_URL}/w/{workspace.slug}/billing?checkout=cancel",
        client_reference_id=str(workspace.id),
        subscription_data={"metadata": {"workspace_id": str(workspace.id)}},
        metadata={"workspace_id": str(workspace.id), "plan": plan},
    )
    if settings.STRIPE_MOCK:
        # stripe-mock has no hosted payment page; use our simulated checkout page instead.
        return f"/w/{workspace.slug}/billing/checkout?plan={plan}&session={session['id']}"
    return session["url"]


def create_portal_session(workspace):
    sub = workspace.subscription
    if not sub.stripe_customer_id:
        raise StripeNotConfigured("This workspace has no Stripe customer yet — subscribe first.")
    session = _client().billing_portal.Session.create(
        customer=sub.stripe_customer_id, return_url=f"{settings.FRONTEND_URL}/w/{workspace.slug}/billing"
    )
    if settings.STRIPE_MOCK:
        return f"/w/{workspace.slug}/billing/checkout?manage=1"
    return session["url"]


def _ts(value):
    return datetime.fromtimestamp(value, tz=timezone.utc) if value else None


def _audit_change(sub, before):
    """Audit what a Stripe event changed (plan and/or status), as a system entry."""
    changes = {k: [before[k], getattr(sub, k)] for k in ("plan", "status") if before[k] != getattr(sub, k)}
    if changes:
        record_system(sub.workspace, "billing.stripe_update", sub, changes)


def sync_subscription(stripe_sub, event_created=None):
    """Apply a Stripe Subscription object to our local Subscription row (or ignore it if it's stale)."""
    ws_id = (stripe_sub.get("metadata") or {}).get("workspace_id")
    rows = Subscription.objects.select_for_update().select_related("workspace")
    sub = rows.filter(workspace_id=ws_id).first() if ws_id else None
    if sub is None:
        sub = rows.filter(stripe_customer_id=stripe_sub.get("customer")).first()
    if sub is None:
        return None

    incoming = stripe_sub.get("id", "")
    if sub.stripe_subscription_id and incoming and incoming != sub.stripe_subscription_id:
        logger.info("Ignoring event for subscription %s; workspace %s is on %s",
                    incoming, sub.workspace_id, sub.stripe_subscription_id)
        return sub
    if event_created and sub.stripe_event_created and event_created < sub.stripe_event_created:
        logger.info("Ignoring out-of-order event (created %s, last applied %s)", event_created, sub.stripe_event_created)
        return sub

    before = {"plan": sub.plan, "status": sub.status}
    items = (stripe_sub.get("items") or {}).get("data") or []
    price = items[0]["price"]["id"] if items else None
    period_end = stripe_sub.get("current_period_end") or (items[0].get("current_period_end") if items else None)
    status = stripe_sub.get("status", "active")
    sub.stripe_subscription_id = incoming
    sub.stripe_customer_id = stripe_sub.get("customer") or sub.stripe_customer_id
    sub.status = status if status in Subscription.Status.values else Subscription.Status.INCOMPLETE
    sub.plan = plan_for_price(price) or sub.plan
    sub.current_period_end = _ts(period_end)
    sub.cancel_at_period_end = bool(stripe_sub.get("cancel_at_period_end"))
    if status == "canceled":
        sub.plan = "free"
        sub.status = Subscription.Status.ACTIVE
        sub.stripe_subscription_id = ""
        sub.current_period_end = None
        sub.cancel_at_period_end = False
    if event_created:
        sub.stripe_event_created = event_created
    sub.save()
    _audit_change(sub, before)
    return sub


SUBSCRIPTION_EVENTS = {
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
}


def _apply(event):
    obj = event["data"]["object"]
    if event["type"] in SUBSCRIPTION_EVENTS:
        sub = sync_subscription(obj, event.get("created"))
        if sub:
            logger.info("Workspace %s now on %s (%s)", sub.workspace_id, sub.plan, sub.status)
    elif event["type"] == "checkout.session.completed" and obj.get("subscription"):
        ws_id = (obj.get("metadata") or {}).get("workspace_id") or obj.get("client_reference_id")
        # Never replace a different subscription the workspace already has.
        Subscription.objects.filter(workspace_id=ws_id, stripe_subscription_id__in=["", obj["subscription"]]).update(
            stripe_customer_id=obj.get("customer") or "", stripe_subscription_id=obj["subscription"]
        )
    elif event["type"] == "invoice.payment_failed":
        rows = Subscription.objects.select_for_update().select_related("workspace").filter(
            stripe_customer_id=obj.get("customer"))
        if obj.get("subscription"):  # only the current subscription's invoices count
            rows = rows.filter(stripe_subscription_id=obj["subscription"])
        for sub in rows:
            before = {"plan": sub.plan, "status": sub.status}
            sub.status = Subscription.Status.PAST_DUE
            sub.save(update_fields=["status", "updated_at"])
            _audit_change(sub, before)


def process_webhook(payload: bytes, signature: str):
    """Verify a Stripe webhook and apply it. Returns (http_status, body). Idempotent per event id.

    If applying the event raises, nothing is saved (not even the "processed" mark) and the error
    becomes a 500, so Stripe retries the delivery later.
    """
    try:
        stripe.Webhook.construct_event(payload, signature, settings.STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.SignatureVerificationError) as exc:
        logger.warning("Invalid Stripe webhook: %s", exc)
        return 400, {"detail": "invalid signature"}

    # Work with plain dicts: StripeObject (stripe>=8) is not a dict and has no .get().
    event = json.loads(payload)
    with transaction.atomic():
        try:
            with transaction.atomic():
                StripeEvent.objects.create(event_id=event["id"], type=event["type"])
        except IntegrityError:
            return 200, {"status": "duplicate"}
        _apply(event)
    return 200, {"status": "ok"}
