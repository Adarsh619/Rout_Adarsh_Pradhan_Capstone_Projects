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


def record(request, action, instance, changes=None, emit_event=True):
    """Write an audit entry and (optionally) fan the event out to webhooks/notifications."""
    ws = request.workspace
    ip = request.META.get("HTTP_X_FORWARDED_FOR", request.META.get("REMOTE_ADDR", "")).split(",")[0].strip() or None
    entry = AuditLog.objects.create(
        workspace=ws,
        actor=request.user if request.user.is_authenticated else None,
        action=action,
        entity_type=instance._meta.model_name,
        entity_id=str(instance.pk),
        entity_label=str(instance)[:255],
        changes=changes or {},
        ip_address=ip,
    )
    if emit_event:
        from apps.integrations.events import emit

        emit(ws, action, {
            "entity": {"type": entry.entity_type, "id": entry.entity_id, "label": entry.entity_label},
            "changes": entry.changes,
            "actor": request.user.email if request.user.is_authenticated else None,
        })
    return entry
