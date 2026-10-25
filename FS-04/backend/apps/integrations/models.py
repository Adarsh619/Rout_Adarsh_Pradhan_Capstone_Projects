import secrets

from django.conf import settings
from django.db import models

from apps.tenancy.models import TenantModel

WEBHOOK_EVENTS = [
    "issue.created", "issue.updated", "issue.moved", "issue.deleted",
    "comment.created", "sprint.started", "sprint.completed",
    "project.created", "project.updated", "project.deleted", "attachment.created",
]


def generate_secret():
    return "whsec_" + secrets.token_hex(24)


class Webhook(TenantModel):
    """Outgoing webhook. Payloads are signed with HMAC-SHA256 in the X-TaskFlow-Signature header."""

    url = models.URLField(max_length=500)
    events = models.JSONField(default=list, help_text="Event names; empty list = all events")
    secret = models.CharField(max_length=80, default=generate_secret)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def subscribed_to(self, event):
        return self.is_active and (not self.events or event in self.events)

    def __str__(self):
        return self.url


class WebhookDelivery(TenantModel):
    webhook = models.ForeignKey(Webhook, on_delete=models.CASCADE, related_name="deliveries")
    event = models.CharField(max_length=60)
    payload = models.JSONField()
    status_code = models.PositiveIntegerField(null=True, blank=True)
    response_body = models.TextField(blank=True)
    success = models.BooleanField(default=False)
    attempts = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    delivered_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]


class Notification(TenantModel):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    verb = models.CharField(max_length=40)  # assigned / commented / moved / due_soon
    issue = models.ForeignKey("tracker.Issue", null=True, on_delete=models.CASCADE, related_name="+")
    message = models.CharField(max_length=255)
    read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class Report(TenantModel):
    """Generated in the background by Celery (weekly, or on demand)."""

    kind = models.CharField(max_length=30, default="weekly_summary")
    data = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
