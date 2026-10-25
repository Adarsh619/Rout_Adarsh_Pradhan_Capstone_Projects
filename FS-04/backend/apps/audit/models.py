from django.conf import settings
from django.db import models

from apps.tenancy.models import TenantModel


class AuditLog(TenantModel):
    """Append-only record of who changed what in a workspace."""

    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    action = models.CharField(max_length=60, db_index=True)  # e.g. issue.updated
    entity_type = models.CharField(max_length=40)
    entity_id = models.CharField(max_length=40)
    entity_label = models.CharField(max_length=255, blank=True)
    changes = models.JSONField(default=dict, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["workspace", "entity_type", "entity_id"])]

    def __str__(self):
        return f"{self.action} {self.entity_label}"
