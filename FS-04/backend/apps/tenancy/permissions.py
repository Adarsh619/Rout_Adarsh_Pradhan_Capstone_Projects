"""Role-based permissions per workspace.

Role ladder: viewer < member < admin < owner.
- viewer: read only
- member: create/edit issues, comments, attachments; move cards
- admin:  manage projects, boards, sprints, workflows, members, webhooks
- owner:  billing, delete workspace
"""
from rest_framework import permissions

from .models import Role


class IsWorkspaceMember(permissions.BasePermission):
    message = "You are not a member of this workspace."

    def has_permission(self, request, view):
        return getattr(request, "membership", None) is not None


class WorkspaceRolePermission(permissions.BasePermission):
    """Reads need `read_role` (viewer); writes need `view.write_role` (default member)."""

    message = "Your role in this workspace does not allow this action."

    def has_permission(self, request, view):
        membership = getattr(request, "membership", None)
        if membership is None:
            return False
        if request.method in permissions.SAFE_METHODS:
            needed = getattr(view, "read_role", Role.VIEWER)
        else:
            role_map = getattr(view, "action_roles", {})
            needed = role_map.get(getattr(view, "action", None), getattr(view, "write_role", Role.MEMBER))
        return membership.has_role(needed)
