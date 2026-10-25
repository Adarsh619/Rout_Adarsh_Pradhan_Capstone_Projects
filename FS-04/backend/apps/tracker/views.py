from django.db.models import Count, Q
from django.http import FileResponse
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from apps.audit.services import model_diff, record
from apps.billing.limits import enforce_limit
from apps.integrations.notify import notify_issue_event
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
        active = project.sprints.filter(state=Sprint.State.ACTIVE).first()
        if sprint == "active" or (sprint is None and board.kind == Board.Kind.SCRUM):
            issues = issues.filter(sprint=active) if active else issues.none()
        elif sprint == "all":
            pass
        elif sprint == "backlog":
            issues = issues.filter(sprint__isnull=True)
        elif sprint and sprint.isdigit():
            issues = issues.filter(sprint_id=int(sprint))
        if request.query_params.get("assignee"):
            issues = issues.filter(assignee_id=request.query_params["assignee"])
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
        sprint.save(update_fields=["state"])
        record(request, "sprint.started", sprint)
        return Response(self.get_serializer(sprint).data)

    @action(detail=True, methods=["post"])
    def complete(self, request, pk=None):
        sprint = self.get_object()
        if sprint.state != Sprint.State.ACTIVE:
            raise ValidationError("Only active sprints can be completed.")
        unfinished = sprint.issues.exclude(status__category=StatusCategory.DONE)
        moved = unfinished.update(sprint=None)  # carry over to backlog
        sprint.state = Sprint.State.CLOSED
        sprint.save(update_fields=["state"])
        record(request, "sprint.completed", sprint, {"returned_to_backlog": moved})
        return Response({"sprint": self.get_serializer(sprint).data, "returned_to_backlog": moved})


# --- issues -----------------------------------------------------------------
class IssueViewSet(AuditedViewSet):
    queryset = (
        Issue.objects.select_related("project", "status", "assignee", "reporter")
        .annotate(comment_count=Count("comments"))
    )
    serializer_class = IssueSerializer
    filterset_fields = ["project", "status", "assignee", "sprint", "type", "priority"]
    search_fields = ["title", "description"]
    ordering_fields = ["created_at", "updated_at", "priority", "rank", "due_date"]
    audit_name = "issue"

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("backlog") == "true":
            qs = qs.filter(sprint__isnull=True)
        return qs

    def perform_create(self, serializer):
        enforce_limit(self.request.workspace, "issues")
        issue = create_issue(serializer, self.request.workspace, self.request.user)
        record(self.request, "issue.created", issue, {"title": issue.title})
        if issue.assignee_id:
            notify_issue_event(issue, "assigned", self.request.user)

    def perform_update(self, serializer):
        old_assignee = serializer.instance.assignee_id
        issue = super().perform_update(serializer)
        if issue.assignee_id and issue.assignee_id != old_assignee:
            notify_issue_event(issue, "assigned", self.request.user)

    @action(detail=True, methods=["post"])
    def move(self, request, pk=None):
        """Drag-and-drop endpoint: {"status": <status id>, "index": <position in column>}."""
        issue = self.get_object()
        ser = IssueMoveSerializer(data=request.data, context=self.get_serializer_context())
        ser.is_valid(raise_exception=True)
        old_status = issue.status
        issue = move_issue(issue, ser.validated_data["status"], ser.validated_data.get("index"))
        if old_status != issue.status:
            record(request, "issue.moved", issue, {"status": [old_status.name, issue.status.name]})
            notify_issue_event(issue, "moved", request.user)
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
        instance.file.delete(save=False)
        super().perform_destroy(instance)

    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        att = self.get_object()  # tenant-scoped lookup
        return FileResponse(att.file.open("rb"), as_attachment=True, filename=att.filename)
