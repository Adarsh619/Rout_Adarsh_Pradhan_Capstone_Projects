"""Housekeeping for the public demo site. Both tasks do nothing unless DEMO_MODE is on."""
import logging
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db.models import ProtectedError
from django.utils import timezone

from apps.accounts.demo import DEMO_WORKSPACES, is_demo_account
from apps.tenancy.models import Workspace
from apps.tenancy.services import delete_workspace

logger = logging.getLogger(__name__)


@shared_task
def reset_demo_data(issues=60):
    """Rebuild the demo companies every night, so whatever visitors changed is gone for the next person."""
    if not settings.DEMO_MODE:
        return "skipped: DEMO_MODE is off"
    call_command("seed_demo", reset=True, force=True, issues=issues)
    purged = purge_visitor_data()
    return f"demo reset; {purged}"


@shared_task
def purge_visitor_data():
    """Delete workspaces and accounts that visitors created more than DEMO_VISITOR_RETENTION_DAYS ago."""
    if not settings.DEMO_MODE:
        return "skipped: DEMO_MODE is off"
    cutoff = timezone.now() - timedelta(days=settings.DEMO_VISITOR_RETENTION_DAYS)
    workspaces = 0
    for ws in Workspace.objects.exclude(slug__in=DEMO_WORKSPACES).filter(created_at__lt=cutoff):
        delete_workspace(ws)
        workspaces += 1
    users = 0
    stale = get_user_model().objects.filter(date_joined__lt=cutoff, is_staff=False, is_superuser=False)
    for user in stale.exclude(memberships__isnull=False).exclude(owned_workspaces__isnull=False):
        if is_demo_account(user):
            continue
        try:
            user.delete()
            users += 1
        except ProtectedError:  # still owns something; it goes once that workspace is purged
            logger.warning("purge_visitor_data: kept %s (still referenced)", user.email)
    return f"purged {workspaces} workspaces, {users} accounts"
