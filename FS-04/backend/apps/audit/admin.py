from django.contrib import admin

from .models import AuditLog


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    """Read-only: the audit log is append-only, so admin can browse it but not add, edit or delete entries."""

    list_display = ["created_at", "workspace", "actor_email", "action", "entity_label", "ip_address"]
    list_filter = ["action", "workspace"]
    list_select_related = ["workspace"]
    search_fields = ["actor_email", "entity_label", "action"]
    date_hierarchy = "created_at"

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
