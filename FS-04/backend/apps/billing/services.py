"""Thin wrapper around Stripe Billing (test mode or stripe-mock)."""
import json
import logging
from datetime import datetime, timezone

import stripe
from django.conf import settings
from django.db import IntegrityError, transaction
from rest_framework.exceptions import APIException

from .models import StripeEvent, Subscription
from .plans import plan_for_price, price_id

logger = logging.getLogger(__name__)


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


def create_checkout_session(workspace, plan, user):
    price = price_id(plan)
    if not price:
        raise StripeNotConfigured(f"No Stripe price configured for plan '{plan}'.")
    sub = workspace.subscription
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


def sync_subscription(stripe_sub):
    """Apply a Stripe Subscription object to our local Subscription row."""
    sub = None
    ws_id = (stripe_sub.get("metadata") or {}).get("workspace_id")
    if ws_id:
        sub = Subscription.objects.filter(workspace_id=ws_id).first()
    if sub is None:
        sub = Subscription.objects.filter(stripe_customer_id=stripe_sub.get("customer")).first()
    if sub is None:
        return None
    items = (stripe_sub.get("items") or {}).get("data") or []
    price = items[0]["price"]["id"] if items else None
    period_end = stripe_sub.get("current_period_end") or (items[0].get("current_period_end") if items else None)
    status = stripe_sub.get("status", "active")
    sub.stripe_subscription_id = stripe_sub.get("id", "")
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
    sub.save()
    return sub


SUBSCRIPTION_EVENTS = {
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
}


def process_webhook(payload: bytes, signature: str):
    """Verify a Stripe webhook and apply it. Returns (http_status, body). Idempotent per event id."""
    try:
        stripe.Webhook.construct_event(payload, signature, settings.STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.SignatureVerificationError) as exc:
        logger.warning("Invalid Stripe webhook: %s", exc)
        return 400, {"detail": "invalid signature"}

    # Work with plain dicts: StripeObject (stripe>=8) is not a dict and has no .get().
    event = json.loads(payload)
    try:
        with transaction.atomic():
            StripeEvent.objects.create(event_id=event["id"], type=event["type"])
    except IntegrityError:
        return 200, {"status": "duplicate"}

    obj = event["data"]["object"]
    if event["type"] in SUBSCRIPTION_EVENTS:
        sub = sync_subscription(obj)
        if sub:
            logger.info("Workspace %s now on %s (%s)", sub.workspace_id, sub.plan, sub.status)
    elif event["type"] == "checkout.session.completed" and obj.get("subscription"):
        ws_id = (obj.get("metadata") or {}).get("workspace_id") or obj.get("client_reference_id")
        Subscription.objects.filter(workspace_id=ws_id).update(
            stripe_customer_id=obj.get("customer") or "", stripe_subscription_id=obj["subscription"]
        )
    elif event["type"] == "invoice.payment_failed":
        Subscription.objects.filter(stripe_customer_id=obj.get("customer")).update(
            status=Subscription.Status.PAST_DUE
        )
    return 200, {"status": "ok"}
