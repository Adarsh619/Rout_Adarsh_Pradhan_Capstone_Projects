"""Stripe sends webhooks late, out of order, more than once, and sometimes while our side is failing."""
from unittest import mock

import pytest
from django.db import connection
from django.db.transaction import TransactionManagementError
from django.test import Client
from django.test.utils import CaptureQueriesContext

from apps.audit.models import AuditLog
from apps.billing.limits import enforce_limit
from apps.billing.models import StripeEvent, Subscription
from tests.test_billing import _post_signed

pytestmark = pytest.mark.django_db


def sub_event(event_id, workspace, sub_id="sub_1", created=100, status="active", price="price_pro",
              etype="customer.subscription.updated"):
    return {
        "id": event_id, "object": "event", "type": etype, "created": created,
        "data": {"object": {
            "id": sub_id, "customer": "cus_1", "status": status, "cancel_at_period_end": False,
            "current_period_end": 1893456000, "metadata": {"workspace_id": str(workspace.id)},
            "items": {"data": [{"price": {"id": price}}]},
        }},
    }


def sub_of(workspace):
    return Subscription.objects.get(workspace=workspace)


# --- 1. late and out-of-order events --------------------------------------------------------


def test_late_delete_of_an_old_subscription_does_not_downgrade(client, stripe_live, workspace):
    # The owner cancelled sub_old and subscribed again (sub_new); the old "deleted" event arrives last.
    _post_signed(client, sub_event("evt_new", workspace, sub_id="sub_new", created=200))
    assert sub_of(workspace).plan == "pro"
    r = _post_signed(client, sub_event("evt_old", workspace, sub_id="sub_old", created=300, status="canceled",
                                       etype="customer.subscription.deleted"))
    assert r.status_code == 200
    sub = sub_of(workspace)
    assert sub.plan == "pro" and sub.stripe_subscription_id == "sub_new"


def test_older_event_arriving_late_is_ignored(client, stripe_live, settings, workspace):
    settings.STRIPE_PRICE_BUSINESS = "price_business"
    _post_signed(client, sub_event("evt_2", workspace, created=200, price="price_business"))
    _post_signed(client, sub_event("evt_1", workspace, created=100, price="price_pro"))  # sent first, arrived second
    sub = sub_of(workspace)
    assert sub.plan == "business" and sub.stripe_event_created == 200
    assert StripeEvent.objects.count() == 2  # both recorded, so Stripe's retries of evt_1 are duplicates


def test_checkout_completed_never_replaces_a_different_subscription(client, stripe_live, workspace):
    _post_signed(client, sub_event("evt_a", workspace, sub_id="sub_current", created=100))
    session = {"id": "evt_b", "type": "checkout.session.completed", "created": 150, "data": {"object": {
        "customer": "cus_1", "subscription": "sub_other", "metadata": {"workspace_id": str(workspace.id)}}}}
    _post_signed(client, session)
    assert sub_of(workspace).stripe_subscription_id == "sub_current"


def test_payment_failure_of_another_subscription_is_ignored(client, stripe_live, workspace):
    _post_signed(client, sub_event("evt_a", workspace, sub_id="sub_current", created=100))
    failed = {"id": "evt_f", "type": "invoice.payment_failed", "created": 150,
              "data": {"object": {"customer": "cus_1", "subscription": "sub_old"}}}
    _post_signed(client, failed)
    assert sub_of(workspace).status == "active"
    failed["id"], failed["data"]["object"]["subscription"] = "evt_g", "sub_current"
    _post_signed(client, failed)
    assert sub_of(workspace).status == "past_due"


# --- 2. a failure doesn't lose the event -----------------------------------------------------------


def test_failed_processing_is_retried_not_skipped(stripe_live, workspace):
    event = sub_event("evt_boom", workspace)
    client = Client(raise_request_exception=False)
    with mock.patch("apps.billing.services.sync_subscription", side_effect=RuntimeError("database hiccup")):
        assert _post_signed(client, event).status_code == 500  # Stripe will retry
    assert not StripeEvent.objects.filter(event_id="evt_boom").exists()
    assert sub_of(workspace).plan == "free"

    r = _post_signed(client, event)  # Stripe's retry
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert sub_of(workspace).plan == "pro"


# --- 3. no second subscription ---------------------------------------------------------------------


def test_checkout_refused_while_subscribed(api, stripe_live, settings, workspace):
    settings.STRIPE_SECRET_KEY = "sk_test_x"
    Subscription.objects.filter(workspace=workspace).update(plan="pro", stripe_subscription_id="sub_1",
                                                            stripe_customer_id="cus_1")
    with mock.patch("stripe.checkout.Session.create") as create:
        r = api.post("/api/billing/checkout/", {"plan": "business"}, format="json")
    assert r.status_code == 400 and "Manage subscription" in str(r.data)
    create.assert_not_called()

    # Once the subscription has ended, checkout works again.
    Subscription.objects.filter(workspace=workspace).update(plan="free", stripe_subscription_id="")
    with mock.patch("stripe.checkout.Session.create", return_value={"id": "cs_1", "url": "https://checkout.test/s"}):
        assert api.post("/api/billing/checkout/", {"plan": "pro"}, format="json").status_code == 200


# --- 4. Stripe's changes are audited --------------------------------------------------------------


def test_plan_and_status_changes_from_stripe_are_audited(client, stripe_live, workspace):
    _post_signed(client, sub_event("evt_1", workspace, created=100))
    entry = AuditLog.objects.get(action="billing.stripe_update")
    assert entry.changes == {"plan": ["free", "pro"]} and entry.actor is None and entry.actor_email == ""

    _post_signed(client, sub_event("evt_2", workspace, created=200))  # same state again: nothing to audit
    assert AuditLog.objects.filter(action="billing.stripe_update").count() == 1

    _post_signed(client, {"id": "evt_3", "type": "invoice.payment_failed", "created": 300,
                          "data": {"object": {"customer": "cus_1", "subscription": "sub_1"}}})
    last = AuditLog.objects.filter(action="billing.stripe_update").latest("id")
    assert last.changes == {"status": ["active", "past_due"]}


# --- 5. limits and customers under concurrency --------------------------------------------------


def test_limit_check_locks_the_subscription_row(api, workspace):
    with CaptureQueriesContext(connection) as ctx:
        assert api.post("/api/projects/", {"key": "LK", "name": "Locked"}, format="json").status_code == 201
    assert any("billing_subscription" in q["sql"] and "FOR UPDATE" in q["sql"] for q in ctx.captured_queries)


@pytest.mark.django_db(transaction=True)  # no test-wide transaction, like a real request in autocommit
def test_limit_check_must_run_inside_a_transaction(workspace):
    # Outside a transaction the lock would be released at once, so enforce_limit refuses to run.
    with pytest.raises(TransactionManagementError):
        enforce_limit(workspace, "projects")


# --- 6. API schema and admin ------------------------------------------------------------------------


def test_billing_endpoints_are_fully_described_in_the_schema():
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(public=True)
    checkout = schema["paths"]["/api/billing/checkout/"]["post"]
    assert "requestBody" in checkout and "200" in checkout["responses"]
    overview = schema["components"]["schemas"]["BillingOverview"]["properties"]
    assert {"plan", "effective_plan", "limits", "usage", "can_manage"} <= set(overview)


def test_admin_cannot_rewrite_stripe_links_or_the_event_log(owner, client, stripe_live, workspace):
    _post_signed(client, sub_event("evt_1", workspace))
    owner.is_staff = owner.is_superuser = True
    owner.save()
    c = Client()
    c.force_login(owner)
    sub = sub_of(workspace)
    page = c.get(f"/admin/billing/subscription/{sub.pk}/change/").content.decode()
    assert 'name="plan"' in page and 'name="stripe_subscription_id"' not in page
    event = StripeEvent.objects.get()
    assert c.post(f"/admin/billing/stripeevent/{event.pk}/delete/", {"post": "yes"}).status_code == 403
    assert c.get("/admin/billing/stripeevent/add/").status_code == 403
