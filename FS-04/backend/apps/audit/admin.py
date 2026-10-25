from django.contrib import admin

from .models import AuditLog


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ["created_at", "workspace", "actor", "action", "entity_label"]
    list_filter = ["action", "workspace"]
