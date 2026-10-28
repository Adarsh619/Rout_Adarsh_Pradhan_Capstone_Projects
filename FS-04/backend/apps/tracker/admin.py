"""Django admin for the tracker. Pickers search instead of listing every tenant's rows, the
models' clean() rejects links across workspaces, and counters / ordering can't be hand-edited."""
from django.contrib import admin
from django.db import transaction

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


@admin.register(Workflow)
class WorkflowAdmin(admin.ModelAdmin):
    list_display = ["name", "workspace", "is_default", "created_at"]
    list_filter = ["is_default"]
    list_select_related = ["workspace"]
    search_fields = ["name", "workspace__name", "workspace__slug"]
    autocomplete_fields = ["workspace"]


@admin.register(WorkflowStatus)
class WorkflowStatusAdmin(admin.ModelAdmin):
    list_display = ["name", "workflow", "category", "color", "order", "workspace"]
    list_filter = ["category"]
    list_select_related = ["workflow", "workspace"]
    search_fields = ["name", "workflow__name"]
    autocomplete_fields = ["workspace", "workflow"]


@admin.register(WorkflowTransition)
class WorkflowTransitionAdmin(admin.ModelAdmin):
    list_display = ["__str__", "workflow", "workspace"]
    list_select_related = ["workflow", "from_status", "to_status", "workspace"]
    autocomplete_fields = ["workspace", "workflow", "from_status", "to_status"]


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ["key", "name", "workspace", "workflow", "issue_counter"]
    list_select_related = ["workspace", "workflow"]
    search_fields = ["key", "name", "workspace__name"]
    autocomplete_fields = ["workspace", "workflow", "lead"]
    readonly_fields = ["issue_counter"]  # issue numbers come from this; editing it could duplicate keys


@admin.register(Board)
class BoardAdmin(admin.ModelAdmin):
    list_display = ["name", "project", "kind", "workspace"]
    list_filter = ["kind"]
    list_select_related = ["project", "workspace"]
    autocomplete_fields = ["workspace", "project"]


@admin.register(Sprint)
class SprintAdmin(admin.ModelAdmin):
    list_display = ["name", "project", "state", "start_date", "end_date"]
    list_filter = ["state"]
    list_select_related = ["project"]
    search_fields = ["name", "project__key"]
    autocomplete_fields = ["workspace", "project"]


@admin.register(Issue)
class IssueAdmin(admin.ModelAdmin):
    list_display = ["key", "title", "status", "assignee", "priority", "workspace"]
    list_filter = ["priority", "type", "status__category"]
    list_select_related = ["project", "status", "assignee", "workspace"]
    search_fields = ["title", "project__key"]
    autocomplete_fields = ["workspace", "project", "status", "sprint", "assignee", "reporter"]
    readonly_fields = ["number", "rank", "created_at", "updated_at"]

    @transaction.atomic
    def save_model(self, request, obj, form, change):
        if not change:
            # Same numbering as the API: take the next KEY-N under a row lock.
            project = Project.objects.select_for_update().get(pk=obj.project_id)
            project.issue_counter += 1
            project.save(update_fields=["issue_counter"])
            obj.number = project.issue_counter
        super().save_model(request, obj, form, change)


@admin.register(Comment)
class CommentAdmin(admin.ModelAdmin):
    list_display = ["__str__", "author", "created_at", "workspace"]
    list_select_related = ["author", "workspace"]
    search_fields = ["body"]
    autocomplete_fields = ["workspace", "issue", "author"]


@admin.register(Attachment)
class AttachmentAdmin(admin.ModelAdmin):
    list_display = ["filename", "issue", "size", "uploaded_by", "created_at"]
    list_select_related = ["issue__project", "uploaded_by"]
    search_fields = ["filename"]
    autocomplete_fields = ["workspace", "issue", "uploaded_by"]
    readonly_fields = ["filename", "size"]
