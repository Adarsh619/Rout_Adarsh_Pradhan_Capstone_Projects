"""Core project-management domain: workflows, projects, boards, sprints, issues, comments, attachments.

Every model inherits TenantModel, so each row is owned by exactly one workspace.
"""
import os

from django.conf import settings
from django.db import models

from apps.tenancy.models import TenantModel


# --- Custom workflows -------------------------------------------------------
class Workflow(TenantModel):
    """A set of statuses and the allowed transitions between them."""

    name = models.CharField(max_length=80)
    is_default = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

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
    color = models.CharField(max_length=7, default="#64748b")
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]
        constraints = [models.UniqueConstraint(fields=["workflow", "name"], name="unique_status_per_workflow")]

    def __str__(self):
        return self.name


class WorkflowTransition(TenantModel):
    workflow = models.ForeignKey(Workflow, on_delete=models.CASCADE, related_name="transitions")
    from_status = models.ForeignKey(WorkflowStatus, on_delete=models.CASCADE, related_name="+")
    to_status = models.ForeignKey(WorkflowStatus, on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["workflow", "from_status", "to_status"], name="unique_transition")
        ]


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

    def __str__(self):
        return self.name


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


class Comment(TenantModel):
    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]


def attachment_path(instance, filename):
    return f"workspaces/{instance.workspace_id}/issues/{instance.issue_id}/{filename}"


class Attachment(TenantModel):
    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="attachments")
    file = models.FileField(upload_to=attachment_path)
    filename = models.CharField(max_length=255, blank=True)
    size = models.PositiveIntegerField(default=0)
    uploaded_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)

    def save(self, *args, **kwargs):
        if self.file and not self.filename:
            self.filename = os.path.basename(self.file.name)
        if self.file and not self.size:
            self.size = self.file.size
        super().save(*args, **kwargs)
