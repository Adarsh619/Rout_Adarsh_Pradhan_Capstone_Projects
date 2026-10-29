from django.contrib import admin

from .models import StripeEvent, Subscription


@admin.register(Subscription)
class SubscriptionAdmin(admin.ModelAdmin):
    """Plan and status stay editable for support; the links to Stripe are only ever set by Stripe's webhooks."""

    list_display = ["workspace", "plan", "status", "current_period_end", "cancel_at_period_end"]
    list_filter = ["plan", "status"]
    list_select_related = ["workspace"]
    search_fields = ["workspace__name", "workspace__slug", "stripe_customer_id", "stripe_subscription_id"]
    readonly_fields = ["workspace", "stripe_customer_id", "stripe_subscription_id", "stripe_event_created", "updated_at"]

    def has_add_permission(self, request):
        return False  # every workspace gets its subscription row when it's created


@admin.register(StripeEvent)
class StripeEventAdmin(admin.ModelAdmin):
    """The processed-event log that makes webhooks idempotent: browse it, don't edit it."""

    list_display = ["received_at", "type", "event_id"]
    list_filter = ["type"]
    search_fields = ["event_id"]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
