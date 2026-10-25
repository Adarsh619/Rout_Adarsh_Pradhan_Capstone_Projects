from django.contrib import admin

from .models import (
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

for m in [Workflow, WorkflowStatus, WorkflowTransition, Board, Sprint, Comment, Attachment]:
    admin.site.register(m)


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ["key", "name", "workspace"]
    list_filter = ["workspace"]


@admin.register(Issue)
class IssueAdmin(admin.ModelAdmin):
    list_display = ["id", "title", "project", "status", "assignee", "priority"]
    list_filter = ["workspace", "priority", "type"]
    search_fields = ["title"]
