import ipaddress

from django.conf import settings
from django.db import models

from .models import AuditLog


def model_diff(instance, data, fields=None):
    """Return {field: [old, new]} for fields in `data` that differ from `instance`."""
    changes = {}
    for field, new in data.items():
        if fields and field not in fields:
            continue
        old = getattr(instance, field, None)
        if isinstance(old, models.Model):
            old = old.pk
        if isinstance(new, models.Model):
            new = new.pk
        if old != new:
            changes[field] = [_plain(old), _plain(new)]
    return changes


def _plain(v):
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)


def client_ip(request):
    """The caller's IP address, as seen by the outermost proxy we trust.

    Proxies *append* to X-Forwarded-For (nginx's $proxy_add_x_forwarded_for), so the left-most value is
    whatever the browser sent and can't be trusted. With TRUSTED_PROXY_COUNT = n, the n-th value from the
    right is the address our own proxy saw. With 0 (no proxy, e.g. runserver) the header is ignored.
    Same rule as DRF's NUM_PROXIES, which the rate limits use.
    """
    trusted = settings.TRUSTED_PROXY_COUNT
    forwarded = [part.strip() for part in request.META.get("HTTP_X_FORWARDED_FOR", "").split(",") if part.strip()]
    ip = forwarded[-min(trusted, len(forwarded))] if trusted and forwarded else request.META.get("REMOTE_ADDR")
    try:
        return str(ipaddress.ip_address(ip)) if ip else None
    except ValueError:
        return None


def record(request, action, instance, changes=None, emit_event=True, workspace=None):
    """Write an audit entry and (optionally) fan the event out to webhooks/notifications.

    `workspace` is for views that aren't tenant-scoped (the workspace list), where request.workspace is unset.
    The actor's email is stored too, so the entry still says who acted after their account is deleted.
    """
    ws = workspace or request.workspace
    actor = request.user if request.user.is_authenticated else None
    entry = AuditLog.objects.create(
        workspace=ws,
        actor=actor,
        actor_email=actor.email if actor else "",
        action=action,
        entity_type=instance._meta.model_name,
        entity_id=str(instance.pk),
        entity_label=str(instance)[:255],
        changes=changes or {},
        ip_address=client_ip(request),
    )
    if emit_event:
        from apps.integrations.events import emit

        emit(ws, action, {
            "entity": {"type": entry.entity_type, "id": entry.entity_id, "label": entry.entity_label},
            "changes": entry.changes,
            "actor": request.user.email if request.user.is_authenticated else None,
        })
    return entry


def record_system(workspace, action, instance, changes=None):
    """Audit a change made by the system rather than a person (e.g. a Stripe webhook): no actor, no IP.

    The audit log page shows these as "system". Not sent to webhooks.
    """
    return AuditLog.objects.create(
        workspace=workspace, action=action, entity_type=instance._meta.model_name, entity_id=str(instance.pk),
        entity_label=str(instance)[:255], changes=changes or {},
    )
