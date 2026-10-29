from django.conf import settings
from django.http import Http404
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.services import record
from apps.tenancy.mixins import TenantScopedMixin
from apps.tenancy.models import Role

from . import mock
from .limits import usage
from .models import Subscription
from .plans import PLANS
from .services import create_checkout_session, create_portal_session, process_webhook


def billing_mode():
    if settings.STRIPE_MOCK:
        return "mock"
    return "live" if settings.STRIPE_SECRET_KEY else "disabled"


# --- request / response shapes (also what Swagger and docs/openapi.yaml show) -------------------
class BillingOverviewSerializer(serializers.Serializer):
    plan = serializers.ChoiceField(choices=list(PLANS))
    effective_plan = serializers.ChoiceField(choices=list(PLANS), help_text="Plan whose limits apply (Free if past due)")
    status = serializers.ChoiceField(choices=Subscription.Status.choices)
    current_period_end = serializers.DateTimeField(allow_null=True)
    cancel_at_period_end = serializers.BooleanField()
    limits = serializers.DictField(child=serializers.IntegerField(allow_null=True), help_text="null = unlimited")
    usage = serializers.DictField(child=serializers.IntegerField())
    plans = serializers.DictField(help_text="Plan catalogue: name, price_usd and limits per plan")
    mode = serializers.ChoiceField(choices=["mock", "live", "disabled"])
    stripe_enabled = serializers.BooleanField()
    has_subscription = serializers.BooleanField()
    can_manage = serializers.BooleanField(help_text="True for the owner")


class CheckoutSerializer(serializers.Serializer):
    plan = serializers.ChoiceField(choices=["pro", "business"])


class RedirectSerializer(serializers.Serializer):
    url = serializers.CharField(help_text="Stripe's hosted page, or the app's simulated page in mock mode")


class MockActionSerializer(serializers.Serializer):
    action = serializers.ChoiceField(choices=["subscribe", "cancel"], default="subscribe")
    plan = serializers.ChoiceField(choices=["pro", "business"], required=False)


WebhookResult = inline_serializer("StripeWebhookResult", {"status": serializers.CharField()})


class BillingView(TenantScopedMixin, APIView):
    """GET current plan, limits and usage for the workspace."""

    @extend_schema(responses=BillingOverviewSerializer)
    def get(self, request):
        sub, _ = Subscription.objects.get_or_create(workspace=request.workspace)
        mode = billing_mode()
        return Response({
            "plan": sub.plan,
            "effective_plan": sub.effective_plan,
            "status": sub.status,
            "current_period_end": sub.current_period_end,
            "cancel_at_period_end": sub.cancel_at_period_end,
            "limits": PLANS[sub.effective_plan]["limits"],
            "usage": usage(request.workspace),
            "plans": PLANS,
            "mode": mode,
            "stripe_enabled": mode != "disabled",
            "has_subscription": bool(sub.stripe_subscription_id),
            "can_manage": request.membership.has_role(Role.OWNER),
        })


class CheckoutView(TenantScopedMixin, APIView):
    """Start a subscription. Refused (400) if the workspace already has one: change plans through the portal."""

    write_role = Role.OWNER

    @extend_schema(request=CheckoutSerializer, responses=RedirectSerializer)
    def post(self, request):
        ser = CheckoutSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        Subscription.objects.get_or_create(workspace=request.workspace)
        url = create_checkout_session(request.workspace, ser.validated_data["plan"], request.user)
        return Response({"url": url})


class PortalView(TenantScopedMixin, APIView):
    """Open Stripe's Customer Portal to change plan or cancel."""

    write_role = Role.OWNER

    @extend_schema(request=None, responses=RedirectSerializer)
    def post(self, request):
        return Response({"url": create_portal_session(request.workspace)})


class StripeWebhookView(APIView):
    """Receives Stripe events. Signature is verified with STRIPE_WEBHOOK_SECRET."""

    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    throttle_classes = []

    @extend_schema(request=OpenApiTypes.OBJECT, responses={200: WebhookResult, 400: WebhookResult},
                   description="Called by Stripe. Returns 400 for a bad signature; duplicates return status 'duplicate'.")
    def post(self, request):
        status, body = process_webhook(request.body, request.headers.get("Stripe-Signature", ""))
        return Response(body, status=status)


class MockCompleteView(TenantScopedMixin, APIView):
    """STRIPE_MOCK only: act as Stripe after the simulated checkout/portal page.

    Sends signed Stripe events through the real webhook handler.
    """

    write_role = Role.OWNER

    @extend_schema(request=MockActionSerializer, responses=inline_serializer("MockBillingResult", {
        "plan": serializers.CharField(), "status": serializers.CharField(),
        "webhooks": serializers.ListField(child=serializers.DictField()),
    }))
    def post(self, request):
        if not settings.STRIPE_MOCK:
            raise Http404("Mock billing is disabled.")
        ser = MockActionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        sub, _ = Subscription.objects.get_or_create(workspace=request.workspace)
        action, plan = ser.validated_data["action"], ser.validated_data.get("plan")
        if action == "subscribe":
            if not plan:
                raise serializers.ValidationError({"plan": "Choose a plan."})
            action = "change" if sub.stripe_subscription_id else "subscribe"
        elif not sub.stripe_subscription_id:
            raise serializers.ValidationError("There is no subscription to cancel.")
        old_plan = sub.plan
        results = mock.deliver(mock.simulate_events(sub, action, plan))
        sub.refresh_from_db()
        # The owner's click; the plan change itself is also audited as "billing.stripe_update" by the webhook handler.
        record(request, f"billing.{action}", sub, {"plan": [old_plan, sub.plan]}, emit_event=False)
        return Response({"plan": sub.plan, "status": sub.status, "webhooks": [r[1] for r in results]})
