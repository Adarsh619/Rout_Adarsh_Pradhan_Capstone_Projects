from rest_framework.exceptions import NotFound, ValidationError

from .models import Membership
from .permissions import WorkspaceRolePermission


def resolve_workspace(request):
    """Attach request.workspace / request.membership from the X-Workspace header."""
    if hasattr(request, "_workspace_resolved"):
        return
    request._workspace_resolved = True
    request.workspace = None
    request.membership = None
    # Header only: a slug in the URL would end up in access logs and browser history.
    slug = request.headers.get("X-Workspace")
    if not slug:
        raise ValidationError({"detail": "X-Workspace header is required."})
    membership = (
        Membership.objects.select_related("workspace")
        .filter(workspace__slug=slug, user=request.user)
        .first()
    )
    if membership is None:
        # Same response whether the workspace exists or not: don't leak tenant names.
        raise NotFound("Workspace not found.")
    request.workspace = membership.workspace
    request.membership = membership


class TenantScopedMixin:
    """Every queryset is filtered by the current workspace and every create stamps it."""

    permission_classes = [WorkspaceRolePermission]

    def initial(self, request, *args, **kwargs):
        # Authenticate first, then resolve tenant, then check permissions.
        self.perform_authentication(request)
        if request.user and request.user.is_authenticated:
            resolve_workspace(request)
        super().initial(request, *args, **kwargs)

    def get_queryset(self):
        return super().get_queryset().filter(workspace=self.request.workspace)

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx["workspace"] = getattr(self.request, "workspace", None)
        return ctx

    def perform_create(self, serializer):
        serializer.save(workspace=self.request.workspace)
