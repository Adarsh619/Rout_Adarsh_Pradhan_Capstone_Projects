from django.db import IntegrityError, transaction
from django.db.models import Case, Count, IntegerField, Q, Value, When
from django.http import FileResponse
from django_filters.rest_framework import DjangoFilterBackend
from drf_spectacular.utils import extend_schema
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.filters import OrderingFilter, SearchFilter
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from apps.audit.services import model_diff, record
from apps.billing.limits import enforce_limit
from apps.integrations.models import Notification
from apps.integrations.notify import notify_issue_event, notify_workspace_admins
from apps.tenancy.mixins import TenantScopedMixin
from apps.tenancy.models import Role

from .models import (
    Attachment,
    Board,
    Comment,
    Issue,
    Project,
    Sprint,
    StatusCategory,
    Workflow,
    WorkflowStatus,
    WorkflowTransition,
)
from .serializers import (
    AttachmentSerializer,
    BoardSerializer,
    CommentSerializer,
    IssueMoveSerializer,
    IssueSerializer,
    ProjectSerializer,
    SprintSerializer,
    WorkflowSerializer,
    WorkflowStatusSerializer,
    WorkflowTransitionSerializer,
)
from .services import create_issue, default_workflow, move_issue


class AuditedViewSet(TenantScopedMixin, viewsets.ModelViewSet):
    """ModelViewSet that writes an audit entry (and webhook event) for create/update/delete."""

    audit_name = None  # e.g. "project" -> project.created / project.updated / project.deleted

    def perform_create(self, serializer):
        obj = serializer.save(workspace=self.request.workspace)
        record(self.request, f"{self.audit_name}.created", obj)
        return obj

    def perform_update(self, serializer):
        changes = model_diff(serializer.instance, serializer.validated_data)
        obj = serializer.save()
        if changes:
            record(self.request, f"{self.audit_name}.updated", obj, changes)
        return obj

    def perform_destroy(self, instance):
        record(self.request, f"{self.audit_name}.deleted", instance)
        instance.delete()


# --- workflows ------------------------------------------------------------
class WorkflowViewSet(AuditedViewSet):
    queryset = Workflow.objects.prefetch_related("statuses", "transitions")
    serializer_class = WorkflowSerializer
    write_role = Role.ADMIN
    audit_name = "workflow"

    def perform_destroy(self, instance):
        if instance.is_default or instance.projects.exists():
            raise ValidationError("Default workflows or workflows used by projects cannot be deleted.")
        super().perform_destroy(instance)


class WorkflowStatusViewSet(AuditedViewSet):
    queryset = WorkflowStatus.objects.all()
    serializer_class = WorkflowStatusSerializer
    write_role = Role.ADMIN
    filterset_fields = ["workflow"]
    audit_name = "status"

    def perform_destroy(self, instance):
        if instance.issues.exists():
            raise ValidationError("Move issues out of this status before deleting it.")
        if not instance.workflow.statuses.exclude(pk=instance.pk).exists():
            # New issues start in the workflow's first status, so a workflow can't be left with none.
            raise ValidationError("A workflow needs at least one status.")
        super().perform_destroy(instance)


class WorkflowTransitionViewSet(AuditedViewSet):
    queryset = WorkflowTransition.objects.all()
    serializer_class = WorkflowTransitionSerializer
    write_role = Role.ADMIN
    filterset_fields = ["workflow"]
    http_method_names = ["get", "post", "delete"]
    audit_name = "transition"


# --- projects / boards / sprints ------------------------------------------
class ProjectViewSet(AuditedViewSet):
    queryset = Project.objects.annotate(issue_count=Count("issues")).prefetch_related("boards")
    serializer_class = ProjectSerializer
    write_role = Role.ADMIN
    search_fields = ["name", "key"]
    audit_name = "project"

    @transaction.atomic  # the limit check and the new project are one step (see enforce_limit)
    def perform_create(self, serializer):
        ws = self.request.workspace
        enforce_limit(ws, "projects")
        workflow = serializer.validated_data.get("workflow") or default_workflow(ws)
        project = serializer.save(workspace=ws, workflow=workflow)
        Board.objects.create(workspace=ws, project=project, name=f"{project.key} board")
        record(self.request, "project.created", project)

    @action(detail=True, methods=["get"])
    def stats(self, request, pk=None):
        project = self.get_object()
        by_cat = dict(
            project.issues.values_list("status__category").annotate(c=Count("id")).values_list("status__category", "c")
        )
        return Response({
            "total": sum(by_cat.values()),
            "by_category": {c: by_cat.get(c, 0) for c in StatusCategory.values},
            "by_priority": dict(project.issues.values_list("priority").annotate(c=Count("id"))),
            "by_type": dict(project.issues.values_list("type").annotate(c=Count("id"))),
        })


class BoardViewSet(AuditedViewSet):
    queryset = Board.objects.select_related("project")
    serializer_class = BoardSerializer
    write_role = Role.ADMIN
    filterset_fields = ["project"]
    audit_name = "board"

    @action(detail=True, methods=["get"])
    def columns(self, request, pk=None):
        """Board columns = statuses of the project's workflow, each with its ordered issues.

        Query params: `sprint=<id>|active|backlog|all`, `assignee=<id>`, `q=<text>`.
        Scrum boards default to the active sprint; Kanban boards default to all issues.
        """
        board = self.get_object()
        project = board.project
        issues = (
            Issue.objects.filter(workspace=request.workspace, project=project)
            .select_related("assignee", "reporter", "status", "project")
            .annotate(comment_count=Count("comments"))
            .order_by("rank", "id")
        )
        sprint = request.query_params.get("sprint")
        assignee = request.query_params.get("assignee")
        if sprint is not None and sprint not in {"active", "backlog", "all"} and not sprint.isdigit():
            raise ValidationError({"sprint": "Use a sprint id, active, backlog or all."})
        if assignee and not assignee.isdigit():
            raise ValidationError({"assignee": "Use a user id."})
        active = project.sprints.filter(state=Sprint.State.ACTIVE).first()
        if sprint == "active" or (sprint is None and board.kind == Board.Kind.SCRUM):
            issues = issues.filter(sprint=active) if active else issues.none()
        elif sprint == "all":
            pass
        elif sprint == "backlog":
            issues = issues.filter(sprint__isnull=True)
        elif sprint:
            issues = issues.filter(sprint_id=int(sprint))
        if assignee:
            issues = issues.filter(assignee_id=int(assignee))
        if request.query_params.get("q"):
            issues = issues.filter(Q(title__icontains=request.query_params["q"]))
        ctx = self.get_serializer_context()
        by_status = {}
        for issue in issues:
            by_status.setdefault(issue.status_id, []).append(issue)
        workflow = project.workflow
        return Response({
            "board": BoardSerializer(board, context=ctx).data,
            "project": {"id": project.id, "key": project.key, "name": project.name},
            "active_sprint": SprintSerializer(active, context=ctx).data if active else None,
            "transitions": list(workflow.transitions.values("from_status", "to_status")),
            "columns": [
                {
                    "status": WorkflowStatusSerializer(s, context=ctx).data,
                    "issues": IssueSerializer(by_status.get(s.id, []), many=True, context=ctx).data,
                }
                for s in workflow.statuses.all()
            ],
        })


class SprintViewSet(AuditedViewSet):
    queryset = Sprint.objects.annotate(issue_count=Count("issues"))
    serializer_class = SprintSerializer
    write_role = Role.ADMIN
    filterset_fields = ["project", "state"]
    audit_name = "sprint"

    @action(detail=True, methods=["post"])
    def start(self, request, pk=None):
        sprint = self.get_object()
        if sprint.state != Sprint.State.PLANNED:
            raise ValidationError("Only planned sprints can be started.")
        if Sprint.objects.filter(project=sprint.project, state=Sprint.State.ACTIVE).exists():
            raise ValidationError("This project already has an active sprint.")
        sprint.state = Sprint.State.ACTIVE
        try:
            # Two Start clicks can both pass the check above; the one_active_sprint_per_project index stops the second.
            with transaction.atomic():
                sprint.save(update_fields=["state"])
        except IntegrityError as e:
            raise ValidationError("This project already has an active sprint.") from e
        record(request, "sprint.started", sprint)
        return Response(self.get_serializer(sprint).data)

    @action(detail=True, methods=["post"])
    @transaction.atomic
    def complete(self, request, pk=None):
        # One transaction: issues return to the backlog and the sprint closes together, or neither happens.
        sprint = self.get_object()
        sprint.state = Sprint.objects.select_for_update().values_list("state", flat=True).get(pk=sprint.pk)
        if sprint.state != Sprint.State.ACTIVE:
            raise ValidationError("Only active sprints can be completed.")
        unfinished = sprint.issues.exclude(status__category=StatusCategory.DONE)
        moved = unfinished.update(sprint=None)  # carry over to backlog
        sprint.state = Sprint.State.CLOSED
        sprint.save(update_fields=["state"])
        record(request, "sprint.completed", sprint, {"returned_to_backlog": moved})
        return Response({"sprint": self.get_serializer(sprint).data, "returned_to_backlog": moved})


# --- issues -----------------------------------------------------------------
PRIORITY_RANK = Case(
    *[When(priority=p, then=Value(i)) for i, p in enumerate(Issue.Priority.values)],  # low=0 … critical=3
    output_field=IntegerField(),
)


class IssueOrderingFilter(OrderingFilter):
    """`?ordering=priority` sorts by severity (low → critical), not alphabetically."""

    def get_ordering(self, request, queryset, view):
        ordering = super().get_ordering(request, queryset, view) or []
        return [o.replace("priority", "priority_rank") if o.lstrip("-") == "priority" else o for o in ordering]

    def filter_queryset(self, request, queryset, view):
        return super().filter_queryset(request, queryset.annotate(priority_rank=PRIORITY_RANK), view)


class IssueViewSet(AuditedViewSet):
    queryset = (
        Issue.objects.select_related("project", "status", "assignee", "reporter")
        .annotate(comment_count=Count("comments"))
    )
    serializer_class = IssueSerializer
    filter_backends = [DjangoFilterBackend, SearchFilter, IssueOrderingFilter]
    filterset_fields = ["project", "status", "assignee", "sprint", "type", "priority"]
    search_fields = ["title", "description"]
    ordering_fields = ["created_at", "updated_at", "priority", "rank", "due_date"]
    audit_name = "issue"

    def perform_destroy(self, instance):
        if not instance.can_be_deleted_by(self.request.membership):
            raise PermissionDenied("Only the reporter or an admin can delete this issue.")
        super().perform_destroy(instance)

    @action(detail=True, methods=["post"])
    def request_deletion(self, request, pk=None):
        """A member who can't delete an issue asks the workspace's admins and owner to do it."""
        issue = self.get_object()
        if issue.can_be_deleted_by(request.membership):
            raise ValidationError("You can delete this issue yourself.")
        pending = Notification.objects.filter(
            workspace=request.workspace, actor=request.user, issue=issue, verb="delete_requested", read=False
        )
        if pending.exists():  # don't flood admins with repeat clicks
            return Response({"already_requested": True})
        notes = notify_workspace_admins(issue, "delete_requested", request.user)
        record(request, "issue.deletion_requested", issue, {"title": issue.title}, emit_event=False)
        return Response({"notified": len(notes)}, status=status.HTTP_202_ACCEPTED)

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("backlog") == "true":
            qs = qs.filter(sprint__isnull=True)
        return qs

    @transaction.atomic  # the limit check and the new issue are one step (see enforce_limit)
    def perform_create(self, serializer):
        enforce_limit(self.request.workspace, "issues")
        issue = create_issue(serializer, self.request.workspace, self.request.user)
        record(self.request, "issue.created", issue, {"title": issue.title})
        if issue.assignee_id:
            notify_issue_event(issue, "assigned", self.request.user)

    def _move(self, issue, to_status, index=None, after=None, before=None):
        """Every status change (drag on the board or the issue form) re-ranks, audits and notifies the same way."""
        old_status = issue.status
        move_issue(issue, to_status, index, after=after, before=before)
        if old_status != issue.status:
            record(self.request, "issue.moved", issue, {"status": [old_status.name, issue.status.name]})
            notify_issue_event(issue, "moved", self.request.user)
        return issue

    @transaction.atomic
    def perform_update(self, serializer):
        issue = serializer.instance
        # Lock the row and take its current status, so this save can't undo a move made meanwhile.
        issue.status = Issue.objects.select_for_update().select_related("status").get(pk=issue.pk).status
        old_assignee = issue.assignee_id
        new_status = serializer.validated_data.pop("status", None)
        issue = super().perform_update(serializer)
        if new_status is not None and new_status != issue.status:
            self._move(issue, new_status)  # lands at the bottom of the new column
        if issue.assignee_id and issue.assignee_id != old_assignee:
            notify_issue_event(issue, "assigned", self.request.user)

    @extend_schema(request=IssueMoveSerializer, responses=IssueSerializer)
    @action(detail=True, methods=["post"])
    def move(self, request, pk=None):
        """Drag-and-drop endpoint: {"status": <status id>, "after"/"before": <neighbour issue id>, "index": <position>}."""
        issue = self.get_object()
        ser = IssueMoveSerializer(data=request.data, context=self.get_serializer_context())
        ser.is_valid(raise_exception=True)
        with transaction.atomic():
            data = ser.validated_data
            self._move(issue, data["status"], data.get("index"), after=data.get("after"), before=data.get("before"))
        issue = self.get_queryset().get(pk=issue.pk)
        return Response(self.get_serializer(issue).data)

    @action(detail=True, methods=["get"])
    def history(self, request, pk=None):
        from apps.audit.models import AuditLog
        from apps.audit.serializers import AuditLogSerializer

        issue = self.get_object()
        logs = AuditLog.objects.filter(workspace=request.workspace, entity_type="issue", entity_id=str(issue.pk))
        return Response(AuditLogSerializer(logs[:100], many=True).data)


class CommentViewSet(AuditedViewSet):
    queryset = Comment.objects.select_related("author")
    serializer_class = CommentSerializer
    filterset_fields = ["issue"]
    audit_name = "comment"

    def perform_create(self, serializer):
        comment = serializer.save(workspace=self.request.workspace, author=self.request.user)
        record(self.request, "comment.created", comment, {"issue": comment.issue.key})
        notify_issue_event(comment.issue, "commented", self.request.user)

    def _check_owner(self, comment):
        if comment.author_id != self.request.user.id and not self.request.membership.has_role(Role.ADMIN):
            raise PermissionDenied("Only the author or an admin can change this comment.")

    def perform_update(self, serializer):
        self._check_owner(serializer.instance)
        super().perform_update(serializer)

    def perform_destroy(self, instance):
        self._check_owner(instance)
        super().perform_destroy(instance)


class AttachmentViewSet(AuditedViewSet):
    queryset = Attachment.objects.select_related("uploaded_by")
    serializer_class = AttachmentSerializer
    parser_classes = [MultiPartParser, FormParser]
    filterset_fields = ["issue"]
    http_method_names = ["get", "post", "delete"]
    audit_name = "attachment"

    def perform_create(self, serializer):
        att = serializer.save(workspace=self.request.workspace, uploaded_by=self.request.user)
        record(self.request, "attachment.created", att, {"issue": att.issue.key, "filename": att.filename})

    def perform_destroy(self, instance):
        if instance.uploaded_by_id != self.request.user.id and not self.request.membership.has_role(Role.ADMIN):
            raise PermissionDenied("Only the uploader or an admin can delete this attachment.")
        super().perform_destroy(instance)  # signals.py removes the file once the delete commits

    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        att = self.get_object()  # tenant-scoped lookup
        return FileResponse(att.file.open("rb"), as_attachment=True, filename=att.filename)
