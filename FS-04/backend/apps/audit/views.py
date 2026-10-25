from rest_framework import viewsets

from apps.tenancy.mixins import TenantScopedMixin
from apps.tenancy.models import Role

from .models import AuditLog
from .serializers import AuditLogSerializer


class AuditLogViewSet(TenantScopedMixin, viewsets.ReadOnlyModelViewSet):
    queryset = AuditLog.objects.select_related("actor")
    serializer_class = AuditLogSerializer
    read_role = Role.ADMIN
    filterset_fields = ["action", "entity_type", "entity_id"]
    search_fields = ["entity_label", "action"]
