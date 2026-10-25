from django.contrib import admin

from .models import StripeEvent, Subscription


@admin.register(Subscription)
class SubscriptionAdmin(admin.ModelAdmin):
    list_display = ["workspace", "plan", "status", "current_period_end"]


admin.site.register(StripeEvent)
