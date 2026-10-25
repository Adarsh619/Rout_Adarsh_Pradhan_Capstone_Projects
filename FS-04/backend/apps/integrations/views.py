from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.audit.services import record
from apps.tenancy.mixins import TenantScopedMixin
from apps.tenancy.models import Role

from .events import queue_delivery
from .models import WEBHOOK_EVENTS, Notification, Report, Webhook, WebhookDelivery
from .serializers import (
    NotificationSerializer,
    ReportSerializer,
    WebhookDeliverySerializer,
    WebhookSerializer,
)
from .tasks import generate_weekly_report


class WebhookViewSet(TenantScopedMixin, viewsets.ModelViewSet):
    queryset = Webhook.objects.all()
    serializer_class = WebhookSerializer
    read_role = Role.ADMIN
    write_role = Role.ADMIN

    def perform_create(self, serializer):
        hook = serializer.save(workspace=self.request.workspace)
        record(self.request, "webhook.created", hook, {"url": hook.url}, emit_event=False)

    @action(detail=False, methods=["get"])
    def events(self, request):
        return Response(WEBHOOK_EVENTS)

    @action(detail=True, methods=["post"])
    def ping(self, request, pk=None):
        hook = self.get_object()
        delivery = queue_delivery(hook, "ping", {"message": "Hello from TaskFlow"})
        return Response({"queued": 1, "delivery": delivery.id})

    @action(detail=True, methods=["get"])
    def deliveries(self, request, pk=None):
        hook = self.get_object()
        qs = WebhookDelivery.objects.filter(workspace=request.workspace, webhook=hook)[:50]
        return Response(WebhookDeliverySerializer(qs, many=True).data)


class NotificationViewSet(TenantScopedMixin, mixins.ListModelMixin, mixins.UpdateModelMixin, viewsets.GenericViewSet):
    serializer_class = NotificationSerializer
    queryset = Notification.objects.select_related("issue__project")
    write_role = Role.VIEWER  # everyone may mark their own notifications read
    filterset_fields = ["read"]
    http_method_names = ["get", "patch", "post"]

    def get_queryset(self):
        return super().get_queryset().filter(user=self.request.user)

    @action(detail=False, methods=["post"])
    def mark_all_read(self, request):
        n = self.get_queryset().filter(read=False).update(read=True)
        return Response({"updated": n})

    @action(detail=False, methods=["get"])
    def unread_count(self, request):
        return Response({"count": self.get_queryset().filter(read=False).count()})


class ReportViewSet(TenantScopedMixin, viewsets.ReadOnlyModelViewSet):
    queryset = Report.objects.all()
    serializer_class = ReportSerializer
    read_role = Role.MEMBER
    action_roles = {"generate": Role.ADMIN}

    @action(detail=False, methods=["post"])
    def generate(self, request):
        """Queue a report on demand (runs on the Celery worker)."""
        result = generate_weekly_report.delay(request.workspace.id)
        return Response({"task_id": result.id, "status": "queued"}, status=202)
