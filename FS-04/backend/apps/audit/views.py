import csv
import json

import django_filters
from django.http import HttpResponse
from rest_framework import viewsets
from rest_framework.decorators import action

from apps.tenancy.mixins import TenantScopedMixin
from apps.tenancy.models import Role

from .models import AuditLog
from .serializers import AuditLogAdminSerializer

EXPORT_LIMIT = 10_000


class AuditLogFilter(django_filters.FilterSet):
    """`kind` is the part of the action before the dot (issue, member, billing…); dates are UTC days, inclusive."""

    kind = django_filters.CharFilter(method="filter_kind")
    actor_email = django_filters.CharFilter(field_name="actor_email", lookup_expr="iexact")
    since = django_filters.DateFilter(field_name="created_at", lookup_expr="date__gte")
    until = django_filters.DateFilter(field_name="created_at", lookup_expr="date__lte")

    class Meta:
        model = AuditLog
        fields = ["action", "entity_type", "entity_id"]

    def filter_kind(self, queryset, name, value):
        return queryset.filter(action__startswith=f"{value}.")


def csv_safe(value):
    """Stop spreadsheet apps running a cell as a formula: labels like issue titles are user-written."""
    text = "" if value is None else str(value)
    return f"'{text}" if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


class AuditLogViewSet(TenantScopedMixin, viewsets.ReadOnlyModelViewSet):
    queryset = AuditLog.objects.all()
    serializer_class = AuditLogAdminSerializer
    read_role = Role.ADMIN
    filterset_class = AuditLogFilter
    search_fields = ["entity_label", "action", "actor_email"]

    @action(detail=False, methods=["get"])
    def export(self, request):
        """The filtered log as CSV (newest first, up to 10,000 rows). Same filters as the list."""
        entries = self.filter_queryset(self.get_queryset())[:EXPORT_LIMIT]
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="audit-log-{request.workspace.slug}.csv"'
        writer = csv.writer(response)
        writer.writerow(["time (UTC)", "who", "action", "entity type", "entity id", "entity", "changes", "ip address"])
        for e in entries:
            writer.writerow([
                e.created_at.isoformat(timespec="seconds"), csv_safe(e.actor_email or "system"), e.action,
                e.entity_type, e.entity_id, csv_safe(e.entity_label),
                csv_safe(json.dumps(e.changes, ensure_ascii=False) if e.changes else ""), e.ip_address or "",
            ])
        return response
