from rest_framework import mixins, status, viewsets
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from apps.audit.services import record
from apps.billing.limits import enforce_limit

from .mixins import TenantScopedMixin
from .models import Membership, Role, Workspace
from .serializers import MembershipSerializer, WorkspaceSerializer
from .services import create_workspace, delete_workspace


class WorkspaceViewSet(viewsets.ModelViewSet):
    """Workspaces the current user belongs to. Not tenant-scoped (it is the tenant list)."""

    serializer_class = WorkspaceSerializer
    lookup_field = "slug"
    http_method_names = ["get", "post", "patch", "delete"]

    def get_queryset(self):
        return (
            Workspace.objects.filter(memberships__user=self.request.user)
            .select_related("subscription")
            .prefetch_related("memberships")
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
        self._require(serializer.instance, Role.ADMIN)
        serializer.save()

    def perform_destroy(self, instance):
        self._require(instance, Role.OWNER)
        delete_workspace(instance)


class MembershipViewSet(TenantScopedMixin, mixins.ListModelMixin, mixins.CreateModelMixin,
                        mixins.UpdateModelMixin, mixins.DestroyModelMixin, viewsets.GenericViewSet):
    queryset = Membership.objects.select_related("user").order_by("joined_at")
    serializer_class = MembershipSerializer
    write_role = Role.ADMIN
    http_method_names = ["get", "post", "patch", "delete"]

    def perform_create(self, serializer):
        enforce_limit(self.request.workspace, "members")
        m = serializer.save(workspace=self.request.workspace)
        record(self.request, "member.added", m, {"email": m.user.email, "role": m.role})

    def perform_update(self, serializer):
        old = serializer.instance.role
        m = serializer.save()
        record(self.request, "member.role_changed", m, {"role": [old, m.role]})

    def perform_destroy(self, instance):
        if instance.role == Role.OWNER:
            raise PermissionDenied("The owner cannot be removed.")
        record(self.request, "member.removed", instance, {"email": instance.user.email})
        instance.delete()
