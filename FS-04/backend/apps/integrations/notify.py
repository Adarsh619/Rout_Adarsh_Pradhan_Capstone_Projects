from django.db import transaction

from apps.tenancy.models import Membership

from .models import Notification

MESSAGES = {
    "assigned": "{actor} assigned you {key}: {title}",
    "commented": "{actor} commented on {key}: {title}",
    "moved": "{actor} moved {key} to {status}",
    "due_soon": "{key} is due on {due}: {title}",
}


def notify_issue_event(issue, verb, actor=None):
    """Create in-app notifications for the people involved in an issue and queue emails."""
    recipients = {issue.assignee_id, issue.reporter_id} - {None}
    if verb == "assigned":
        recipients = {issue.assignee_id} - {None}
    if actor is not None:
        recipients.discard(actor.id)
    if recipients:
        # A reporter (or assignee of a done issue) may have left the workspace: never email ex-members.
        recipients = set(
            Membership.objects.filter(workspace_id=issue.workspace_id, user_id__in=recipients)
            .values_list("user_id", flat=True)
        )
    if not recipients:
        return []
    message = MESSAGES[verb].format(
        actor=getattr(actor, "display_name", "TaskFlow"), key=issue.key, title=issue.title[:120],
        status=issue.status.name, due=issue.due_date,
    )
    notes = Notification.objects.bulk_create([
        Notification(workspace_id=issue.workspace_id, user_id=uid, actor=actor, verb=verb, issue=issue,
                     message=message[:255])
        for uid in recipients
    ])
    from .tasks import send_notification_emails

    ids = [n.id for n in notes]
    transaction.on_commit(lambda: send_notification_emails.delay(ids))
    return notes
