from django.db import transaction
from django.utils import timezone

from .models import Webhook, WebhookDelivery


def _payload(workspace, event, data):
    return {"event": event, "workspace": workspace.slug, "occurred_at": timezone.now().isoformat(), "data": data}


def queue_delivery(hook, event, data, payload=None):
    """Persist a delivery row and send it from the Celery worker once the transaction commits.

    `payload` reuses an earlier delivery's exact body (redelivery keeps the original `occurred_at`).
    """
    from .tasks import deliver_webhook

    d = WebhookDelivery.objects.create(
        workspace=hook.workspace, webhook=hook, event=event, payload=payload or _payload(hook.workspace, event, data)
    )
    transaction.on_commit(lambda: deliver_webhook.delay(d.id))
    return d


def emit(workspace, event, data):
    """Fan an event out to every active webhook subscribed to it."""
    hooks = [h for h in Webhook.objects.filter(workspace=workspace, is_active=True) if h.subscribed_to(event)]
    return [queue_delivery(h, event, data) for h in hooks]
