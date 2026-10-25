"""Celery background jobs: webhook delivery, notification emails, reports, reminders."""
import hashlib
import hmac
import json
import logging
from datetime import timedelta

import requests
from celery import shared_task
from django.core.mail import send_mail
from django.db.models import Count, Q
from django.utils import timezone

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 5


def sign(secret, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


@shared_task(bind=True, max_retries=MAX_ATTEMPTS - 1)
def deliver_webhook(self, delivery_id):
    from .models import WebhookDelivery

    d = WebhookDelivery.objects.select_related("webhook").filter(pk=delivery_id).first()
    if d is None or d.success:
        return
    body = json.dumps(d.payload, separators=(",", ":"), default=str).encode()
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "TaskFlow-Webhooks/1.0",
        "X-TaskFlow-Event": d.event,
        "X-TaskFlow-Delivery": str(d.id),
        "X-TaskFlow-Signature": sign(d.webhook.secret, body),
    }
    d.attempts += 1
    try:
        resp = requests.post(d.webhook.url, data=body, headers=headers, timeout=10)
        d.status_code = resp.status_code
        d.response_body = resp.text[:2000]
        d.success = 200 <= resp.status_code < 300
    except requests.RequestException as exc:
        d.response_body = str(exc)[:2000]
        d.success = False
    if d.success:
        d.delivered_at = timezone.now()
    d.save()
    if not d.success and d.attempts < MAX_ATTEMPTS:
        # exponential backoff: 30s, 60s, 120s, 240s
        raise self.retry(countdown=30 * 2 ** (d.attempts - 1))
    return d.success


@shared_task
def send_notification_emails(notification_ids):
    from .models import Notification

    for n in Notification.objects.filter(id__in=notification_ids).select_related("user", "workspace"):
        send_mail(
            subject=f"[{n.workspace.name}] {n.message[:80]}",
            message=n.message,
            from_email=None,
            recipient_list=[n.user.email],
            fail_silently=True,
        )
    return len(notification_ids)


def build_weekly_report(workspace):
    from apps.tracker.models import Issue, StatusCategory

    since = timezone.now() - timedelta(days=7)
    issues = Issue.objects.filter(workspace=workspace)
    created = issues.filter(created_at__gte=since).count()
    done_ids = set()
    from apps.audit.models import AuditLog

    for log in AuditLog.objects.filter(workspace=workspace, action="issue.moved", created_at__gte=since):
        done_ids.add(log.entity_id)
    completed = issues.filter(id__in=done_ids, status__category=StatusCategory.DONE).count()
    by_assignee = list(
        issues.exclude(status__category=StatusCategory.DONE)
        .values("assignee__email")
        .annotate(open=Count("id"))
        .order_by("-open")[:10]
    )
    overdue = issues.filter(Q(due_date__lt=timezone.localdate()) & ~Q(status__category=StatusCategory.DONE)).count()
    return {
        "period_start": since.date().isoformat(),
        "period_end": timezone.localdate().isoformat(),
        "created": created,
        "completed": completed,
        "open_total": issues.exclude(status__category=StatusCategory.DONE).count(),
        "overdue": overdue,
        "open_by_assignee": by_assignee,
    }


@shared_task
def generate_weekly_report(workspace_id):
    from apps.tenancy.models import Workspace

    from .models import Report

    ws = Workspace.objects.get(pk=workspace_id)
    data = build_weekly_report(ws)
    report = Report.objects.create(workspace=ws, kind="weekly_summary", data=data)
    admins = ws.memberships.filter(role__in=["owner", "admin"]).select_related("user")
    send_mail(
        subject=f"[{ws.name}] Weekly summary",
        message=json.dumps(data, indent=2),
        from_email=None,
        recipient_list=[m.user.email for m in admins],
        fail_silently=True,
    )
    return report.id


@shared_task
def generate_all_weekly_reports():
    from apps.tenancy.models import Workspace

    ids = list(Workspace.objects.values_list("id", flat=True))
    for ws_id in ids:
        generate_weekly_report.delay(ws_id)
    return len(ids)


@shared_task
def send_due_date_reminders():
    from apps.tracker.models import Issue, StatusCategory

    from .notify import notify_issue_event

    tomorrow = timezone.localdate() + timedelta(days=1)
    qs = Issue.objects.filter(due_date=tomorrow, assignee__isnull=False).exclude(
        status__category=StatusCategory.DONE
    ).select_related("project", "status")
    count = 0
    for issue in qs:
        notify_issue_event(issue, "due_soon")
        count += 1
    return count
