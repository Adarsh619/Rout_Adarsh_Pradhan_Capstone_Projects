"""Subscription plans and their limits. `None` means unlimited.

Stripe price IDs come from env (create them in the Stripe dashboard in *test mode*).
"""
from django.conf import settings

PLANS = {
    "free": {"name": "Free", "price_usd": 0, "limits": {"projects": 2, "members": 5, "issues": 200}},
    "pro": {"name": "Pro", "price_usd": 10, "limits": {"projects": 20, "members": 50, "issues": 10000}},
    "business": {"name": "Business", "price_usd": 25, "limits": {"projects": None, "members": None, "issues": None}},
}


def price_id(plan):
    return {"pro": settings.STRIPE_PRICE_PRO, "business": settings.STRIPE_PRICE_BUSINESS}.get(plan, "")


def plan_for_price(price):
    for plan in ("pro", "business"):
        if price and price == price_id(plan):
            return plan
    return None
