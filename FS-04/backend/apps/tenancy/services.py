from django.db import transaction
from django.utils.text import slugify

from .models import Membership, Role, Workspace


def unique_slug(name):
    base = slugify(name)[:50] or "workspace"
    slug, i = base, 2
    while Workspace.objects.filter(slug=slug).exists():
        slug = f"{base}-{i}"
        i += 1
    return slug


@transaction.atomic
def create_workspace(name, owner):
    """Create a workspace with an owner membership, a default workflow and a free subscription."""
    from apps.billing.models import Subscription
    from apps.tracker.services import create_default_workflow

    ws = Workspace.objects.create(name=name, slug=unique_slug(name), owner=owner)
    Membership.objects.create(workspace=ws, user=owner, role=Role.OWNER)
    create_default_workflow(ws)
    Subscription.objects.create(workspace=ws)
    return ws


@transaction.atomic
def delete_workspace(workspace):
    """Delete a tenant and all its data.

    Issues and projects are removed first because they PROTECT their workflow/status rows
    (that protection stops admins deleting a status that is still in use).
    """
    from apps.tracker.models import Issue, Project

    Issue.objects.filter(workspace=workspace).delete()
    Project.objects.filter(workspace=workspace).delete()
    workspace.delete()
