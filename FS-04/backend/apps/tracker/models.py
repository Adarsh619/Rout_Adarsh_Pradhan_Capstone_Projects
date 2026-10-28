"""Core project-management domain: workflows, projects, boards, sprints, issues, comments, attachments.

Every model inherits TenantModel, so each row is owned by exactly one workspace.

The API validates requests before they reach these models. `clean()` repeats the cross-tenant checks
for anything that bypasses the API (Django admin, shell scripts), and the Meta constraints make the
one-active-sprint and one-default-workflow rules hold even under concurrent requests.
"""
import os
import re

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import RegexValidator
from django.db import models
from django.db.models import F, Q

from apps.tenancy.models import Membership, TenantModel

hex_color = RegexValidator(r"^#[0-9a-fA-F]{6}$", "Use a hex colour like #2563eb.")
PROJECT_KEY_RE = re.compile(r"[A-Z0-9]+")


def check_tenant(obj, **related):
    """Raise ValidationError for every related object (or user) that isn't in obj's workspace.

    Pass objects as `name=instance`; users are checked by membership, everything else by workspace_id.
    """
    if obj.workspace_id is None:
        return  # the form already reports the missing workspace
    errors = {}
    user_model = Membership._meta.get_field("user").related_model
    for name, value in related.items():
        if value is None:
            continue
        if isinstance(value, user_model):
            if not Membership.objects.filter(workspace_id=obj.workspace_id, user=value).exists():
                errors[name] = "Must be a member of this workspace."
        elif value.workspace_id != obj.workspace_id:
            errors[name] = "Belongs to a different workspace."
    if errors:
        raise ValidationError(errors)


def related(obj, name):
    """The related object if its id is set, else None (avoids RelatedObjectDoesNotExist in clean())."""
    return getattr(obj, name) if getattr(obj, f"{name}_id") is not None else None


# --- Custom workflows -------------------------------------------------------
class Workflow(TenantModel):
    """A set of statuses and the allowed transitions between them."""

    name = models.CharField(max_length=80)
    is_default = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace"], condition=Q(is_default=True), name="one_default_workflow_per_workspace"
            ),
        ]

    def __str__(self):
        return self.name

    def can_transition(self, from_status, to_status):
        if from_status is None or from_status == to_status:
            return True
        transitions = self.transitions.all()
        if not transitions.exists():  # no rules defined -> free movement
            return True
        return transitions.filter(from_status=from_status, to_status=to_status).exists()


class StatusCategory(models.TextChoices):
    TODO = "todo", "To do"
    IN_PROGRESS = "in_progress", "In progress"
    DONE = "done", "Done"


class WorkflowStatus(TenantModel):
    workflow = models.ForeignKey(Workflow, on_delete=models.CASCADE, related_name="statuses")
    name = models.CharField(max_length=50)
    category = models.CharField(max_length=20, choices=StatusCategory.choices, default=StatusCategory.TODO)
    color = models.CharField(max_length=7, default="#64748b", validators=[hex_color])
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]
        constraints = [models.UniqueConstraint(fields=["workflow", "name"], name="unique_status_per_workflow")]

    def __str__(self):
        return self.name

    def clean(self):
        check_tenant(self, workflow=related(self, "workflow"))


class WorkflowTransition(TenantModel):
    workflow = models.ForeignKey(Workflow, on_delete=models.CASCADE, related_name="transitions")
    from_status = models.ForeignKey(WorkflowStatus, on_delete=models.CASCADE, related_name="+")
    to_status = models.ForeignKey(WorkflowStatus, on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["workflow", "from_status", "to_status"], name="unique_transition")
        ]

    def __str__(self):
        return f"{self.from_status} → {self.to_status}"

    def clean(self):
        check_tenant(self, workflow=related(self, "workflow"))
        for name in ["from_status", "to_status"]:
            status = related(self, name)
            if status is not None and status.workflow_id != self.workflow_id:
                raise ValidationError({name: "Must be a status of this workflow."})


# --- Projects / boards / sprints -------------------------------------------
class Project(TenantModel):
    key = models.CharField(max_length=10, help_text="Short prefix for issue keys, e.g. WEB")
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True)
    workflow = models.ForeignKey(Workflow, on_delete=models.PROTECT, related_name="projects")
    lead = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    issue_counter = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]
        constraints = [models.UniqueConstraint(fields=["workspace", "key"], name="unique_project_key_per_workspace")]

    def __str__(self):
        return f"{self.key} — {self.name}"

    def clean(self):
        self.key = (self.key or "").upper()
        if not PROJECT_KEY_RE.fullmatch(self.key):
            raise ValidationError({"key": "Key must be letters A–Z and digits 0–9 only."})
        check_tenant(self, workflow=related(self, "workflow"), lead=related(self, "lead"))


class Board(TenantModel):
    class Kind(models.TextChoices):
        KANBAN = "kanban", "Kanban"
        SCRUM = "scrum", "Scrum"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="boards")
    name = models.CharField(max_length=100)
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.KANBAN)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name

    def clean(self):
        check_tenant(self, project=related(self, "project"))


class Sprint(TenantModel):
    class State(models.TextChoices):
        PLANNED = "planned", "Planned"
        ACTIVE = "active", "Active"
        CLOSED = "closed", "Closed"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="sprints")
    name = models.CharField(max_length=100)
    goal = models.TextField(blank=True)
    start_date = models.DateField(null=True, blank=True)
    end_date = models.DateField(null=True, blank=True)
    state = models.CharField(max_length=10, choices=State.choices, default=State.PLANNED)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["project"], condition=Q(state="active"), name="one_active_sprint_per_project",
                violation_error_message="This project already has an active sprint.",
            ),
            models.CheckConstraint(
                condition=Q(start_date__isnull=True) | Q(end_date__isnull=True) | Q(end_date__gte=F("start_date")),
                name="sprint_ends_after_it_starts",
                violation_error_message="End date must be on or after the start date.",
            ),
        ]

    def __str__(self):
        return self.name

    def clean(self):
        check_tenant(self, project=related(self, "project"))


# --- Issues ---------------------------------------------------------------
class Issue(TenantModel):
    class Type(models.TextChoices):
        TASK = "task", "Task"
        BUG = "bug", "Bug"
        STORY = "story", "Story"
        EPIC = "epic", "Epic"

    class Priority(models.TextChoices):
        LOW = "low", "Low"
        MEDIUM = "medium", "Medium"
        HIGH = "high", "High"
        CRITICAL = "critical", "Critical"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="issues")
    number = models.PositiveIntegerField()
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    type = models.CharField(max_length=10, choices=Type.choices, default=Type.TASK)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.MEDIUM)
    status = models.ForeignKey(WorkflowStatus, on_delete=models.PROTECT, related_name="issues")
    sprint = models.ForeignKey(Sprint, null=True, blank=True, on_delete=models.SET_NULL, related_name="issues")
    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="assigned_issues"
    )
    reporter = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="reported_issues"
    )
    story_points = models.PositiveSmallIntegerField(null=True, blank=True)
    due_date = models.DateField(null=True, blank=True)
    rank = models.FloatField(default=0, help_text="Ordering inside a board column")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["rank", "id"]
        constraints = [models.UniqueConstraint(fields=["project", "number"], name="unique_issue_number")]
        indexes = [
            models.Index(fields=["workspace", "project", "status"]),
            models.Index(fields=["workspace", "assignee"]),
        ]

    def __str__(self):
        return f"{self.key} {self.title}"

    @property
    def key(self):
        return f"{self.project.key}-{self.number}"

    def clean(self):
        project, status, sprint = related(self, "project"), related(self, "status"), related(self, "sprint")
        check_tenant(self, project=project, status=status, sprint=sprint,
                     assignee=related(self, "assignee"), reporter=related(self, "reporter"))
        if project is not None and status is not None and status.workflow_id != project.workflow_id:
            raise ValidationError({"status": "Must be a status of the project's workflow."})
        if project is not None and sprint is not None and sprint.project_id != project.id:
            raise ValidationError({"sprint": "Sprint belongs to a different project."})


class Comment(TenantModel):
    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]

    def __str__(self):
        return f"Comment {self.pk} on issue {self.issue_id}"

    def clean(self):
        check_tenant(self, issue=related(self, "issue"))


def attachment_path(instance, filename):
    return f"workspaces/{instance.workspace_id}/issues/{instance.issue_id}/{filename}"


class Attachment(TenantModel):
    """The stored file is removed after the row is deleted (see `signals.py`), including cascades."""

    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="attachments")
    file = models.FileField(upload_to=attachment_path)
    filename = models.CharField(max_length=255, blank=True)
    size = models.PositiveIntegerField(default=0)
    uploaded_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.filename or self.file.name

    def save(self, *args, **kwargs):
        if self.file and not self.filename:
            self.filename = os.path.basename(self.file.name)
        if self.file and not self.size:
            self.size = self.file.size
        super().save(*args, **kwargs)

    def clean(self):
        check_tenant(self, issue=related(self, "issue"))
