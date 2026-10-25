import json
import os
from unittest import mock

import pytest
import requests

from apps.audit.models import AuditLog
from apps.billing.mock import sign_payload
from apps.billing.models import StripeEvent, Subscription

pytestmark = pytest.mark.django_db


def test_free_plan_project_limit_returns_402(api):
    for i in range(2):
        assert api.post("/api/projects/", {"key": f"P{i}", "name": f"P{i}"}, format="json").status_code == 201
    r = api.post("/api/projects/", {"key": "P3", "name": "P3"}, format="json")
    assert r.status_code == 402 and "Upgrade" in r.data["detail"]


def test_upgraded_plan_raises_limit(api, workspace):
    Subscription.objects.filter(workspace=workspace).update(plan="pro")
    for i in range(3):
        assert api.post("/api/projects/", {"key": f"P{i}", "name": f"P{i}"}, format="json").status_code == 201


def test_past_due_falls_back_to_free_limits(api, workspace):
    Subscription.objects.filter(workspace=workspace).update(plan="pro", status="past_due")
    r = api.get("/api/billing/")
    assert r.data["effective_plan"] == "free" and r.data["limits"]["projects"] == 2


def test_billing_overview(api):
    r = api.get("/api/billing/")
    assert r.data["plan"] == "free" and r.data["usage"]["members"] == 1 and r.data["can_manage"] is True


def test_checkout_without_stripe_config_is_503(api, settings):
    settings.STRIPE_MOCK = False
    settings.STRIPE_SECRET_KEY = ""
    assert api.post("/api/billing/checkout/", {"plan": "pro"}, format="json").status_code == 503


def test_checkout_creates_session(api, settings, workspace):
    settings.STRIPE_MOCK = False
    settings.STRIPE_SECRET_KEY = "sk_test_x"
    settings.STRIPE_PRICE_PRO = "price_pro"
    with mock.patch("stripe.Customer.create", return_value={"id": "cus_1"}), \
            mock.patch("stripe.checkout.Session.create", return_value={"url": "https://checkout.stripe.test/s"}) as cs:
        r = api.post("/api/billing/checkout/", {"plan": "pro"}, format="json")
    assert r.status_code == 200 and r.data["url"].startswith("https://checkout")
    assert cs.call_args.kwargs["line_items"] == [{"price": "price_pro", "quantity": 1}]
    assert Subscription.objects.get(workspace=workspace).stripe_customer_id == "cus_1"


def test_only_owner_can_checkout(workspace, add_member, client_for):
    admin = add_member("a@acme.test", "admin")
    assert client_for(admin, workspace).post("/api/billing/checkout/", {"plan": "pro"}, format="json").status_code == 403


def _sub_event(event_id, workspace, status="active", price="price_pro", etype="customer.subscription.updated"):
    return {
        "id": event_id, "object": "event", "type": etype,
        "data": {"object": {
            "id": "sub_1", "customer": "cus_1", "status": status, "cancel_at_period_end": False,
            "current_period_end": 1893456000, "metadata": {"workspace_id": str(workspace.id)},
            "items": {"data": [{"price": {"id": price}}]},
        }},
    }


def _post_signed(client, event, secret="whsec_test", signature=None):
    """Send a webhook signed exactly like Stripe signs it (no mocking of the verification)."""
    payload = json.dumps(event).encode()
    sig = signature or sign_payload(payload, secret)
    return client.post("/api/billing/stripe-webhook/", data=payload, content_type="application/json",
                       HTTP_STRIPE_SIGNATURE=sig)


@pytest.fixture
def stripe_live(settings):
    settings.STRIPE_MOCK = False
    settings.STRIPE_WEBHOOK_SECRET = "whsec_test"
    settings.STRIPE_PRICE_PRO = "price_pro"


def test_stripe_webhook_syncs_subscription_idempotently(client, stripe_live, workspace):
    event = _sub_event("evt_1", workspace)
    assert _post_signed(client, event).status_code == 200
    assert _post_signed(client, event).data["status"] == "duplicate"
    sub = Subscription.objects.get(workspace=workspace)
    assert sub.plan == "pro" and sub.stripe_subscription_id == "sub_1" and sub.current_period_end.year == 2030
    assert StripeEvent.objects.count() == 1


def test_stripe_cancellation_downgrades(client, stripe_live, workspace):
    Subscription.objects.filter(workspace=workspace).update(plan="pro")
    _post_signed(client, _sub_event("evt_2", workspace, status="canceled", etype="customer.subscription.deleted"))
    sub = Subscription.objects.get(workspace=workspace)
    assert sub.plan == "free" and sub.current_period_end is None


def test_payment_failed_marks_past_due(client, stripe_live, workspace):
    Subscription.objects.filter(workspace=workspace).update(plan="pro", stripe_customer_id="cus_9")
    event = {"id": "evt_3", "type": "invoice.payment_failed", "data": {"object": {"customer": "cus_9"}}}
    _post_signed(client, event)
    assert Subscription.objects.get(workspace=workspace).status == "past_due"


def test_stripe_webhook_rejects_bad_or_wrong_secret_signature(client, stripe_live, workspace):
    event = _sub_event("evt_4", workspace)
    assert _post_signed(client, event, signature="t=1,v1=bad").status_code == 400
    assert _post_signed(client, event, secret="whsec_attacker").status_code == 400
    assert StripeEvent.objects.count() == 0


# --- Mock mode (stripe-mock + simulated checkout) ---------------------------------
@pytest.fixture
def stripe_mock_mode(settings):
    settings.STRIPE_MOCK = True
    settings.STRIPE_SECRET_KEY = "sk_test_mock"
    settings.STRIPE_WEBHOOK_SECRET = "whsec_mock_local"
    settings.STRIPE_PRICE_PRO = "price_mock_pro"
    settings.STRIPE_PRICE_BUSINESS = "price_mock_business"


def test_mock_checkout_returns_local_page(api, stripe_mock_mode):
    with mock.patch("stripe.Customer.create", return_value={"id": "cus_m"}), \
            mock.patch("stripe.checkout.Session.create", return_value={"id": "cs_m", "url": None}):
        r = api.post("/api/billing/checkout/", {"plan": "pro"}, format="json")
    assert r.data["url"] == "/w/acme/billing/checkout?plan=pro&session=cs_m"
    assert api.get("/api/billing/").data["mode"] == "mock"


def test_mock_subscribe_change_and_cancel_go_through_signed_webhooks(api, stripe_mock_mode, workspace):
    r = api.post("/api/billing/mock/complete/", {"plan": "pro"}, format="json")
    assert r.status_code == 200 and r.data["plan"] == "pro"
    assert [w["status"] for w in r.data["webhooks"]] == ["ok", "ok"]
    sub = Subscription.objects.get(workspace=workspace)
    assert sub.stripe_subscription_id.startswith("sub_mock_") and sub.current_period_end
    for i in range(3):  # Pro lifts the free 2-project limit
        assert api.post("/api/projects/", {"key": f"M{i}", "name": f"M{i}"}, format="json").status_code == 201

    assert api.post("/api/billing/mock/complete/", {"plan": "business"}, format="json").data["plan"] == "business"
    assert api.post("/api/billing/mock/complete/", {"action": "cancel"}, format="json").data["plan"] == "free"
    assert StripeEvent.objects.count() == 4
    assert AuditLog.objects.filter(action__startswith="billing.").count() == 3


def test_mock_endpoint_disabled_outside_mock_mode(api, stripe_live):
    assert api.post("/api/billing/mock/complete/", {"plan": "pro"}, format="json").status_code == 404


def test_mock_endpoint_owner_only(workspace, add_member, client_for, stripe_mock_mode):
    admin = add_member("a2@acme.test", "admin")
    r = client_for(admin, workspace).post("/api/billing/mock/complete/", {"plan": "pro"}, format="json")
    assert r.status_code == 403


def _stripe_mock_running(url):
    try:
        return requests.get(url + "/v1/customers", auth=("sk_test_mock", ""), timeout=1).status_code == 200
    except requests.RequestException:
        return False


def test_checkout_against_real_stripe_mock_server(api, stripe_mock_mode, settings, workspace):
    """Integration test: real Stripe SDK calls to Stripe's official stripe-mock server (runs in CI)."""
    url = os.environ.get("STRIPE_MOCK_URL", "http://localhost:12111")
    if not _stripe_mock_running(url):
        pytest.skip("stripe-mock not running")
    settings.STRIPE_API_BASE = url
    try:
        r = api.post("/api/billing/checkout/", {"plan": "pro"}, format="json")
        assert r.status_code == 200, r.data
        assert r.data["url"].startswith("/w/acme/billing/checkout?plan=pro&session=cs_")
        assert Subscription.objects.get(workspace=workspace).stripe_customer_id.startswith("cus_")
        assert api.post("/api/billing/portal/").data["url"] == "/w/acme/billing/checkout?manage=1"
    finally:
        import stripe

        stripe.api_base = "https://api.stripe.com"
