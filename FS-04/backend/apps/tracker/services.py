from django.db import transaction
from rest_framework.exceptions import ValidationError

from .models import Issue, Project, StatusCategory, Workflow, WorkflowStatus, WorkflowTransition

DEFAULT_STATUSES = [
    ("To Do", StatusCategory.TODO, "#64748b"),
    ("In Progress", StatusCategory.IN_PROGRESS, "#2563eb"),
    ("In Review", StatusCategory.IN_PROGRESS, "#9333ea"),
    ("Done", StatusCategory.DONE, "#16a34a"),
]


@transaction.atomic
def create_default_workflow(workspace):
    wf = Workflow.objects.create(workspace=workspace, name="Default workflow", is_default=True)
    statuses = [
        WorkflowStatus.objects.create(workspace=workspace, workflow=wf, name=n, category=c, color=col, order=i)
        for i, (n, c, col) in enumerate(DEFAULT_STATUSES)
    ]
    # Linear flow with the ability to step back; Done can be reopened to To Do.
    pairs = []
    for a, b in zip(statuses, statuses[1:], strict=False):
        pairs += [(a, b), (b, a)]
    pairs.append((statuses[-1], statuses[0]))
    WorkflowTransition.objects.bulk_create(
        [WorkflowTransition(workspace=workspace, workflow=wf, from_status=a, to_status=b) for a, b in pairs]
    )
    return wf


def default_workflow(workspace):
    return Workflow.objects.filter(workspace=workspace, is_default=True).first() or create_default_workflow(workspace)


@transaction.atomic
def create_issue(serializer, workspace, reporter):
    project = Project.objects.select_for_update().get(pk=serializer.validated_data["project"].pk)
    project.issue_counter += 1
    project.save(update_fields=["issue_counter"])
    status = serializer.validated_data.get("status") or project.workflow.statuses.first()
    last = Issue.objects.filter(project=project, status=status).order_by("-rank").first()
    return serializer.save(
        workspace=workspace,
        number=project.issue_counter,
        reporter=reporter,
        status=status,
        rank=(last.rank + 1000) if last else 1000,
    )


@transaction.atomic
def move_issue(issue, to_status, index=None, after=None, before=None):
    """Move an issue to `to_status` at a position within that column, enforcing workflow rules.

    The position is `after` / `before` another issue's id when given (a filtered board only sees some
    cards, so a neighbour is the reliable reference), otherwise `index`; `None` puts it at the bottom.
    The issue's row is locked and its status re-read first, so two simultaneous moves of the same
    card are checked one after the other against the workflow.
    """
    issue.status = Issue.objects.select_for_update().select_related("status").get(pk=issue.pk).status
    if to_status.workflow_id != issue.project.workflow_id:
        raise ValidationError({"status": "Status does not belong to this project's workflow."})
    if not issue.project.workflow.can_transition(issue.status, to_status):
        raise ValidationError(
            {"status": f"Transition '{issue.status.name}' → '{to_status.name}' is not allowed by the workflow."}
        )
    column = list(
        Issue.objects.select_for_update()
        .filter(project=issue.project, status=to_status)
        .exclude(pk=issue.pk)
        .order_by("rank", "id")
    )
    ids = [c.pk for c in column]
    if after in ids:
        index = ids.index(after) + 1
    elif before in ids:
        index = ids.index(before)
    if index is None or index > len(column):
        index = len(column)
    column.insert(max(index, 0), issue)
    issue.status = to_status
    for i, item in enumerate(column):
        item.rank = (i + 1) * 1000
    issue.save(update_fields=["status", "rank", "updated_at"])
    Issue.objects.bulk_update([c for c in column if c.pk != issue.pk], ["rank"])
    return issue
