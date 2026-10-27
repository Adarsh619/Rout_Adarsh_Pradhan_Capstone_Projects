from django.db import IntegrityError, transaction
from django.utils.text import slugify

from .models import Membership, Role, Workspace

SLUG_ATTEMPTS = 5


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

    # unique_slug() checks and then inserts, so two sign-ups with the same company name can pick the
    # same slug at once. The unique index catches the loser, which retries with the next free slug.
    for attempt in range(SLUG_ATTEMPTS):
        try:
            with transaction.atomic():
                ws = Workspace.objects.create(name=name, slug=unique_slug(name), owner=owner)
            break
        except IntegrityError:
            if attempt == SLUG_ATTEMPTS - 1:
                raise
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


@transaction.atomic
def remove_member(request, membership, action):
    """Unassign the person's open issues, audit `action`, then delete the membership.

    Done issues keep their assignee as history; notifications only go to current members,
    so the person hears nothing more about this workspace either way.
    """
    from apps.audit.services import record
    from apps.tracker.models import Issue, StatusCategory

    open_issues = (
        Issue.objects.filter(workspace=membership.workspace, assignee=membership.user)
        .exclude(status__category=StatusCategory.DONE)
        .select_related("project")
    )
    keys = [issue.key for issue in open_issues]
    open_issues.update(assignee=None)
    record(request, action, membership, {"email": membership.user.email, "unassigned_issues": keys})
    membership.delete()
    return keys


@transaction.atomic
def transfer_ownership(workspace, new_owner_membership):
    """Make another member the owner; the previous owner becomes an admin."""
    old = Membership.objects.select_for_update().get(workspace=workspace, user=workspace.owner)
    old.role = Role.ADMIN
    old.save(update_fields=["role"])
    new_owner_membership.role = Role.OWNER
    new_owner_membership.save(update_fields=["role"])
    workspace.owner = new_owner_membership.user
    workspace.save(update_fields=["owner"])
    return old
