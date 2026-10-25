from rest_framework import serializers

from .models import AuditLog


class AuditLogSerializer(serializers.ModelSerializer):
    actor_email = serializers.CharField(source="actor.email", default=None, read_only=True)

    class Meta:
        model = AuditLog
        fields = ["id", "action", "entity_type", "entity_id", "entity_label", "changes", "actor_email", "created_at"]
