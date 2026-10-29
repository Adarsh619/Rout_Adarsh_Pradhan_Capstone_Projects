from django.conf import settings
from django.db import models

from apps.tenancy.models import TenantModel, TenantQuerySet


class AppendOnlyError(Exception):
    """Raised when code tries to change or delete an audit entry."""


class AuditLogQuerySet(TenantQuerySet):
    """Bulk update() and delete() are refused, so entries can't be rewritten in bulk either.

    Deleting a workspace still removes its entries: Django's cascade deletes rows directly
    rather than through QuerySet.delete(). Deleting a user runs `update(actor=None)` (on_delete=SET_NULL),
    the one update allowed; `actor_email` keeps their name on the entry.
    """

    def update(self, **kwargs):
        if kwargs == {"actor": None}:
            return super().update(**kwargs)
        raise AppendOnlyError("Audit entries are append-only.")

    def delete(self):
        raise AppendOnlyError("Audit entries are append-only.")


class AuditLog(TenantModel):
    """Append-only record of who changed what in a workspace."""

    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    # Copied when the entry is written, so it still names the person after their account is deleted.
    actor_email = models.EmailField(blank=True)
    action = models.CharField(max_length=60, db_index=True)  # e.g. issue.updated
    entity_type = models.CharField(max_length=40)
    entity_id = models.CharField(max_length=40)
    entity_label = models.CharField(max_length=255, blank=True)
    changes = models.JSONField(default=dict, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    objects = AuditLogQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["workspace", "entity_type", "entity_id"]),
            models.Index(fields=["workspace", "-created_at"], name="audit_workspace_newest"),
        ]

    def __str__(self):
        return f"{self.action} {self.entity_label}"

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise AppendOnlyError("Audit entries are append-only.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise AppendOnlyError("Audit entries are append-only.")
