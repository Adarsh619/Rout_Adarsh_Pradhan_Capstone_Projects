from django.conf import settings
from django.contrib.auth import get_user_model
from rest_framework import serializers

from apps.accounts.serializers import UserSerializer
from apps.tenancy.models import Membership

from .models import (
    PROJECT_KEY_RE,
    Attachment,
    Board,
    Comment,
    Issue,
    Project,
    Sprint,
    Workflow,
    WorkflowStatus,
    WorkflowTransition,
)


class TenantPKField(serializers.PrimaryKeyRelatedField):
    """PK field that only accepts objects from the current workspace (blocks cross-tenant references)."""

    def get_queryset(self):
        ws = self.context.get("workspace")
        return super().get_queryset().filter(workspace=ws)


class MemberPKField(serializers.PrimaryKeyRelatedField):
    """User PK that must belong to the current workspace."""

    def get_queryset(self):
        ws = self.context.get("workspace")
        ids = Membership.objects.filter(workspace=ws).values_list("user_id", flat=True)
        return get_user_model().objects.filter(id__in=ids)


# --- workflows --------------------------------------------------------------
class WorkflowStatusSerializer(serializers.ModelSerializer):
    workflow = TenantPKField(queryset=Workflow.objects.all())

    class Meta:
        model = WorkflowStatus
        fields = ["id", "workflow", "name", "category", "color", "order"]


class WorkflowTransitionSerializer(serializers.ModelSerializer):
    workflow = TenantPKField(queryset=Workflow.objects.all())
    from_status = TenantPKField(queryset=WorkflowStatus.objects.all())
    to_status = TenantPKField(queryset=WorkflowStatus.objects.all())

    class Meta:
        model = WorkflowTransition
        fields = ["id", "workflow", "from_status", "to_status"]

    def validate(self, attrs):
        wf = attrs["workflow"]
        if attrs["from_status"].workflow_id != wf.id or attrs["to_status"].workflow_id != wf.id:
            raise serializers.ValidationError("Both statuses must belong to the workflow.")
        if attrs["from_status"] == attrs["to_status"]:
            raise serializers.ValidationError("A transition must connect two different statuses.")
        return attrs


class WorkflowSerializer(serializers.ModelSerializer):
    statuses = WorkflowStatusSerializer(many=True, read_only=True)
    transitions = WorkflowTransitionSerializer(many=True, read_only=True)

    class Meta:
        model = Workflow
        fields = ["id", "name", "is_default", "statuses", "transitions", "created_at"]
        read_only_fields = ["is_default", "created_at"]


# --- projects ---------------------------------------------------------------
class ProjectSerializer(serializers.ModelSerializer):
    workflow = TenantPKField(queryset=Workflow.objects.all(), required=False)
    lead = MemberPKField(required=False, allow_null=True)
    issue_count = serializers.IntegerField(read_only=True, default=0)
    board_id = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = ["id", "key", "name", "description", "workflow", "lead", "issue_count", "board_id", "created_at"]
        read_only_fields = ["created_at"]

    def validate_key(self, value):
        value = value.upper()
        if not PROJECT_KEY_RE.fullmatch(value):  # ASCII only: isalnum() also accepts "É" or "²"
            raise serializers.ValidationError("Key must be letters A–Z and digits 0–9 only.")
        qs = Project.objects.filter(workspace=self.context["workspace"], key=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("A project with this key already exists in the workspace.")
        return value

    def validate_workflow(self, value):
        if self.instance and value != self.instance.workflow and self.instance.issues.exists():
            raise serializers.ValidationError("Cannot change workflow of a project that already has issues.")
        return value

    def get_board_id(self, obj):
        board = obj.boards.first()
        return board.id if board else None


class BoardSerializer(serializers.ModelSerializer):
    project = TenantPKField(queryset=Project.objects.all())

    class Meta:
        model = Board
        fields = ["id", "project", "name", "kind", "created_at"]
        read_only_fields = ["created_at"]


class SprintSerializer(serializers.ModelSerializer):
    project = TenantPKField(queryset=Project.objects.all())
    issue_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Sprint
        fields = ["id", "project", "name", "goal", "start_date", "end_date", "state", "issue_count", "created_at"]
        read_only_fields = ["state", "created_at"]

    def validate(self, attrs):
        # On PATCH only one date may be sent; compare it with the one already saved.
        saved = self.instance
        s = attrs.get("start_date", saved.start_date if saved else None)
        e = attrs.get("end_date", saved.end_date if saved else None)
        if s and e and e < s:
            raise serializers.ValidationError({"end_date": "End date must be after start date."})
        return attrs


# --- issues -----------------------------------------------------------------
class IssueSerializer(serializers.ModelSerializer):
    key = serializers.ReadOnlyField()
    project = TenantPKField(queryset=Project.objects.all())
    status = TenantPKField(queryset=WorkflowStatus.objects.all(), required=False)
    sprint = TenantPKField(queryset=Sprint.objects.all(), required=False, allow_null=True)
    assignee = MemberPKField(required=False, allow_null=True)
    assignee_detail = UserSerializer(source="assignee", read_only=True)
    reporter_detail = UserSerializer(source="reporter", read_only=True)
    status_name = serializers.CharField(source="status.name", read_only=True)
    status_category = serializers.CharField(source="status.category", read_only=True)
    comment_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Issue
        fields = [
            "id", "key", "number", "project", "title", "description", "type", "priority",
            "status", "status_name", "status_category", "sprint", "assignee", "assignee_detail",
            "reporter_detail", "story_points", "due_date", "rank", "comment_count", "created_at", "updated_at",
        ]
        read_only_fields = ["number", "rank", "created_at", "updated_at"]

    def validate(self, attrs):
        project = attrs.get("project") or (self.instance and self.instance.project)
        if self.instance and "project" in attrs and attrs["project"] != self.instance.project:
            raise serializers.ValidationError({"project": "Issues cannot be moved between projects."})
        status = attrs.get("status")
        if status and status.workflow_id != project.workflow_id:
            raise serializers.ValidationError({"status": "Status does not belong to this project's workflow."})
        if self.instance and status and status != self.instance.status:
            if not project.workflow.can_transition(self.instance.status, status):
                raise serializers.ValidationError(
                    {"status": f"Transition '{self.instance.status.name}' → '{status.name}' is not allowed."}
                )
        sprint = attrs.get("sprint")
        if sprint and sprint.project_id != project.id:
            raise serializers.ValidationError({"sprint": "Sprint belongs to a different project."})
        return attrs


class IssueMoveSerializer(serializers.Serializer):
    status = TenantPKField(queryset=WorkflowStatus.objects.all())
    index = serializers.IntegerField(min_value=0, required=False)


class CommentSerializer(serializers.ModelSerializer):
    issue = TenantPKField(queryset=Issue.objects.all())
    author = UserSerializer(read_only=True)

    class Meta:
        model = Comment
        fields = ["id", "issue", "author", "body", "created_at", "updated_at"]
        read_only_fields = ["created_at", "updated_at"]


class AttachmentSerializer(serializers.ModelSerializer):
    issue = TenantPKField(queryset=Issue.objects.all())
    uploaded_by = UserSerializer(read_only=True)
    download_url = serializers.SerializerMethodField()

    class Meta:
        model = Attachment
        fields = ["id", "issue", "file", "filename", "size", "uploaded_by", "download_url", "created_at"]
        read_only_fields = ["filename", "size", "created_at"]
        extra_kwargs = {"file": {"write_only": True}}

    def get_download_url(self, obj):
        # Files are never served publicly; downloads go through the tenant-checked API.
        return f"/api/attachments/{obj.pk}/download/"

    def validate_file(self, f):
        if f.size > settings.MAX_ATTACHMENT_SIZE:
            raise serializers.ValidationError(f"File too large (max {settings.MAX_ATTACHMENT_SIZE // 1024 // 1024} MB).")
        return f
