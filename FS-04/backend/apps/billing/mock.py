"""Stripe mock mode.

Used when STRIPE_MOCK=true (e.g. Stripe accounts are invite-only in the developer's country).

What is real and what is simulated:
- REAL: every Stripe SDK call (Customer, Checkout Session, Billing Portal) goes to Stripe's official
  mock server `stripe-mock` (Docker image stripe/stripe-mock), which validates requests against
  Stripe's OpenAPI spec.
- REAL: the webhook handler. Simulated events are signed with STRIPE_WEBHOOK_SECRET using Stripe's
  exact signature scheme and go through `stripe.Webhook.construct_event` and the same sync code
  that real Stripe events use.
- SIMULATED: the hosted checkout page (replaced by a clearly labelled page in our React app) and
  the events Stripe would send after payment.
"""
import hashlib
import hmac
import json
import time
import uuid

from django.conf import settings

from .plans import price_id


def sign_payload(payload: bytes, secret: str, timestamp: int | None = None) -> str:
    """Build a `Stripe-Signature` header exactly like Stripe does (t=..., v1=HMAC-SHA256)."""
    ts = timestamp or int(time.time())
    signed = f"{ts}.".encode() + payload
    sig = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


def _event(event_type, obj):
    return {
        "id": f"evt_mock_{uuid.uuid4().hex[:20]}",
        "object": "event",
        "type": event_type,
        "created": int(time.time()),
        "livemode": False,
        "data": {"object": obj},
    }


def _subscription(sub, plan, status="active"):
    now = int(time.time())
    return {
        "id": sub.stripe_subscription_id or f"sub_mock_{sub.workspace_id}_{uuid.uuid4().hex[:8]}",
        "object": "subscription",
        "customer": sub.stripe_customer_id or f"cus_mock_{sub.workspace_id}",
        "status": status,
        "cancel_at_period_end": False,
        "current_period_end": now + 30 * 24 * 3600,
        "metadata": {"workspace_id": str(sub.workspace_id)},
        "items": {"object": "list", "data": [{"price": {"id": price_id(plan)}, "current_period_end": now + 30 * 24 * 3600}]},
    }


def simulate_events(sub, action, plan=None):
    """Return the Stripe events Stripe would send for `action` ('subscribe' | 'change' | 'cancel')."""
    if action == "cancel":
        obj = _subscription(sub, sub.plan, status="canceled")
        return [_event("customer.subscription.deleted", obj)]
    obj = _subscription(sub, plan)
    if action == "change":
        return [_event("customer.subscription.updated", obj)]
    session = {
        "id": f"cs_mock_{uuid.uuid4().hex[:20]}",
        "object": "checkout.session",
        "mode": "subscription",
        "customer": obj["customer"],
        "subscription": obj["id"],
        "client_reference_id": str(sub.workspace_id),
        "metadata": {"workspace_id": str(sub.workspace_id), "plan": plan},
    }
    return [_event("checkout.session.completed", session), _event("customer.subscription.created", obj)]


def deliver(events):
    """Sign each event and run it through the real webhook processing path."""
    from .services import process_webhook

    results = []
    for ev in events:
        payload = json.dumps(ev).encode()
        header = sign_payload(payload, settings.STRIPE_WEBHOOK_SECRET)
        results.append(process_webhook(payload, header))
    return results
