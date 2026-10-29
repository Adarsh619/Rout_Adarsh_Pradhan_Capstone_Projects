from rest_framework import serializers

from .models import AuditLog


class AuditLogSerializer(serializers.ModelSerializer):
    """Used by an issue's History tab, which every role can open, so no IP address."""

    class Meta:
        model = AuditLog
        fields = ["id", "action", "entity_type", "entity_id", "entity_label", "changes", "actor_email", "created_at"]


class AuditLogAdminSerializer(AuditLogSerializer):
    """The admin-only audit log also shows where each change came from."""

    class Meta(AuditLogSerializer.Meta):
        fields = [*AuditLogSerializer.Meta.fields, "ip_address"]
