from django.db.models import Prefetch
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from apps.audit.services import model_diff, record
from apps.billing.limits import enforce_limit

from .mixins import TenantScopedMixin
from .models import Membership, Role, Workspace
from .serializers import MembershipSerializer, WorkspaceSerializer
from .services import create_workspace, delete_workspace, remove_member, transfer_ownership


class WorkspaceViewSet(viewsets.ModelViewSet):
    """Workspaces the current user belongs to. Not tenant-scoped (it is the tenant list)."""

    serializer_class = WorkspaceSerializer
    lookup_field = "slug"
    http_method_names = ["get", "post", "patch", "delete"]

    def get_queryset(self):
        # Only the caller's own membership is needed (for `role`), not every member of every workspace.
        mine = Membership.objects.filter(user=self.request.user)
        return (
            Workspace.objects.filter(memberships__user=self.request.user)
            .select_related("subscription")
            .prefetch_related(Prefetch("memberships", queryset=mine, to_attr="my_memberships"))
            .distinct()
        )

    def create(self, request, *args, **kwargs):
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        ws = create_workspace(ser.validated_data["name"], request.user)
        ws = self.get_queryset().get(pk=ws.pk)
        return Response(self.get_serializer(ws).data, status=status.HTTP_201_CREATED)

    def _require(self, ws, role):
        m = Membership.objects.filter(workspace=ws, user=self.request.user).first()
        if not m or not m.has_role(role):
            raise PermissionDenied("Insufficient role.")

    def perform_update(self, serializer):
        ws = serializer.instance
        self._require(ws, Role.ADMIN)
        changes = model_diff(ws, serializer.validated_data)
        serializer.save()
        if changes:
            record(self.request, "workspace.updated", ws, changes, emit_event=False, workspace=ws)

    def perform_destroy(self, instance):
        self._require(instance, Role.OWNER)
        delete_workspace(instance)

    @action(detail=True, methods=["post"])
    def transfer(self, request, slug=None):
        """Owner only: `{user_id}` of another member becomes the owner; you become an admin."""
        ws = self.get_object()
        self._require(ws, Role.OWNER)
        user_id = request.data.get("user_id")
        target = Membership.objects.select_related("user").filter(workspace=ws, user_id=user_id).first() \
            if str(user_id).isdigit() else None
        if target is None:
            raise ValidationError({"user_id": "Choose a member of this workspace."})
        if target.user_id == request.user.id:
            raise ValidationError({"user_id": "You already own this workspace."})
        transfer_ownership(ws, target)
        record(request, "workspace.ownership_transferred", ws,
               {"owner": [request.user.email, target.user.email]}, emit_event=False, workspace=ws)
        return Response(self.get_serializer(self.get_queryset().get(pk=ws.pk)).data)


class MembershipViewSet(TenantScopedMixin, mixins.ListModelMixin, mixins.CreateModelMixin,
                        mixins.UpdateModelMixin, mixins.DestroyModelMixin, viewsets.GenericViewSet):
    queryset = Membership.objects.select_related("user").order_by("joined_at")
    serializer_class = MembershipSerializer
    write_role = Role.ADMIN
    action_roles = {"leave": Role.VIEWER}
    http_method_names = ["get", "post", "patch", "delete"]

    def _owner_only_for_admins(self, *roles):
        """Admins manage members and viewers; only the owner can grant, change or remove the admin role."""
        if Role.ADMIN in roles and self.request.membership.role != Role.OWNER:
            raise PermissionDenied("Only the workspace owner can add, change or remove admins.")

    def perform_create(self, serializer):
        self._owner_only_for_admins(serializer.validated_data.get("role", Role.MEMBER))
        enforce_limit(self.request.workspace, "members")
        m = serializer.save(workspace=self.request.workspace)
        record(self.request, "member.added", m, {"email": m.user.email, "role": m.role})

    def perform_update(self, serializer):
        old = serializer.instance.role
        self._owner_only_for_admins(old, serializer.validated_data.get("role", old))
        m = serializer.save()
        record(self.request, "member.role_changed", m, {"role": [old, m.role]})

    def perform_destroy(self, instance):
        if instance.role == Role.OWNER:
            raise PermissionDenied("The owner cannot be removed.")
        self._owner_only_for_admins(instance.role)
        remove_member(self.request, instance, "member.removed")

    @action(detail=False, methods=["post"])
    def leave(self, request):
        """Remove yourself from this workspace. The owner must transfer ownership first."""
        m = request.membership
        if m.role == Role.OWNER:
            raise ValidationError({"detail": "Transfer ownership to another member before leaving."})
        remove_member(request, m, "member.left")
        return Response(status=status.HTTP_204_NO_CONTENT)
