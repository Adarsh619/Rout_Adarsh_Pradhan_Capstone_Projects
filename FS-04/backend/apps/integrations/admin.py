from django.contrib import admin

from .models import Notification, Report, Webhook, WebhookDelivery


@admin.register(Webhook)
class WebhookAdmin(admin.ModelAdmin):
    list_display = ["url", "workspace", "is_active", "created_at"]
    list_filter = ["is_active"]
    list_select_related = ["workspace"]
    search_fields = ["url", "workspace__name"]
    exclude = ["secret"]  # visible to the workspace's admins in the app; no need to show it here too


@admin.register(WebhookDelivery)
class WebhookDeliveryAdmin(admin.ModelAdmin):
    """A log: browse it, don't edit it."""

    list_display = ["created_at", "event", "webhook", "success", "status_code", "attempts"]
    list_filter = ["success", "event"]
    list_select_related = ["webhook"]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ["created_at", "user", "verb", "message", "read"]
    list_filter = ["verb", "read"]
    list_select_related = ["user"]


@admin.register(Report)
class ReportAdmin(admin.ModelAdmin):
    list_display = ["created_at", "workspace", "kind"]
    list_select_related = ["workspace"]
