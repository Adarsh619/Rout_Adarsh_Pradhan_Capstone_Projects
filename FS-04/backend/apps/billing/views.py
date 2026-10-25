from django.conf import settings
from django.http import Http404
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


class BillingView(TenantScopedMixin, APIView):
    """GET current plan, limits and usage for the workspace."""

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


class CheckoutSerializer(serializers.Serializer):
    plan = serializers.ChoiceField(choices=["pro", "business"])


class CheckoutView(TenantScopedMixin, APIView):
    write_role = Role.OWNER

    def post(self, request):
        ser = CheckoutSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        Subscription.objects.get_or_create(workspace=request.workspace)
        url = create_checkout_session(request.workspace, ser.validated_data["plan"], request.user)
        return Response({"url": url})


class PortalView(TenantScopedMixin, APIView):
    write_role = Role.OWNER

    def post(self, request):
        return Response({"url": create_portal_session(request.workspace)})


class StripeWebhookView(APIView):
    """Receives Stripe events. Signature is verified with STRIPE_WEBHOOK_SECRET."""

    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    throttle_classes = []

    def post(self, request):
        status, body = process_webhook(request.body, request.headers.get("Stripe-Signature", ""))
        return Response(body, status=status)


class MockActionSerializer(serializers.Serializer):
    action = serializers.ChoiceField(choices=["subscribe", "cancel"], default="subscribe")
    plan = serializers.ChoiceField(choices=["pro", "business"], required=False)


class MockCompleteView(TenantScopedMixin, APIView):
    """STRIPE_MOCK only: act as Stripe after the simulated checkout/portal page.

    Sends signed Stripe events through the real webhook handler.
    """

    write_role = Role.OWNER

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
        record(request, f"billing.{action}", sub, {"plan": [old_plan, sub.plan]}, emit_event=False)
        return Response({"plan": sub.plan, "status": sub.status, "webhooks": [r[1] for r in results]})
