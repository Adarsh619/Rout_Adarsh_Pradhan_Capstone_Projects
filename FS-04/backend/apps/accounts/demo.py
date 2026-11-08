"""Shared demo accounts on the public live site (DEMO_MODE=true).

`seed_demo` creates two companies whose logins are published on the sign-in page. On a public deployment anyone
can use them, so they can't change their password or profile (one visitor could otherwise lock everyone else out),
and a nightly task rebuilds the demo data (apps/tracker/tasks.py).
"""
from django.conf import settings

DEMO_WORKSPACES = ("acme", "globex")
DEMO_EMAIL_DOMAINS = tuple(f"{slug}.test" for slug in DEMO_WORKSPACES)

DEMO_ACCOUNT_MESSAGE = (
    "This is a shared demo account, so its password and profile can't be changed. "
    "Create your own account to try these settings."
)


def is_demo_account(user):
    """True for the published demo logins (owner@acme.test, member2@globex.test, ...)."""
    email = (getattr(user, "email", "") or "").lower()
    return email.rpartition("@")[2] in DEMO_EMAIL_DOMAINS


def is_locked_demo_account(user):
    """Demo accounts are only locked on a public demo deployment; locally they behave like any other account."""
    return settings.DEMO_MODE and is_demo_account(user)
