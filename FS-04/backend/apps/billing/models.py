from django.db import models

from apps.tenancy.models import Workspace


class Subscription(models.Model):
    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        TRIALING = "trialing", "Trialing"
        PAST_DUE = "past_due", "Past due"
        CANCELED = "canceled", "Canceled"
        INCOMPLETE = "incomplete", "Incomplete"

    workspace = models.OneToOneField(Workspace, on_delete=models.CASCADE, related_name="subscription")
    plan = models.CharField(max_length=20, default="free")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE)
    stripe_customer_id = models.CharField(max_length=80, blank=True)
    stripe_subscription_id = models.CharField(max_length=80, blank=True)
    current_period_end = models.DateTimeField(null=True, blank=True)
    cancel_at_period_end = models.BooleanField(default=False)
    # `created` time (Unix seconds) of the last Stripe subscription event applied; older ones are ignored.
    stripe_event_created = models.PositiveBigIntegerField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.workspace} – {self.plan} ({self.status})"

    @property
    def effective_plan(self):
        # Past-due / canceled workspaces fall back to free limits.
        return self.plan if self.status in {self.Status.ACTIVE, self.Status.TRIALING} else "free"


class StripeEvent(models.Model):
    """Processed Stripe event IDs — makes the webhook idempotent."""

    event_id = models.CharField(max_length=80, unique=True)
    type = models.CharField(max_length=80)
    received_at = models.DateTimeField(auto_now_add=True)
