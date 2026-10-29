from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from apps.audit.services import model_diff, record
from apps.tenancy.mixins import TenantScopedMixin
from apps.tenancy.models import Role

from .events import queue_delivery
from .models import WEBHOOK_EVENTS, Notification, Report, Webhook, WebhookDelivery, generate_secret
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

    # Webhook changes are audited but not sent to webhooks themselves (emit_event=False).
    def perform_create(self, serializer):
        hook = serializer.save(workspace=self.request.workspace)
        record(self.request, "webhook.created", hook, {"url": hook.url}, emit_event=False)

    def perform_update(self, serializer):
        changes = model_diff(serializer.instance, serializer.validated_data)
        hook = serializer.save()
        if changes:
            record(self.request, "webhook.updated", hook, changes, emit_event=False)

    def perform_destroy(self, instance):
        record(self.request, "webhook.deleted", instance, {"url": instance.url}, emit_event=False)
        instance.delete()

    @action(detail=False, methods=["get"])
    def events(self, request):
        return Response(WEBHOOK_EVENTS)

    @action(detail=True, methods=["post"])
    def ping(self, request, pk=None):
        hook = self.get_object()
        delivery = queue_delivery(hook, "ping", {"message": "Hello from TaskFlow"})
        return Response({"queued": 1, "delivery": delivery.id})

    @action(detail=True, methods=["post"])
    def rotate_secret(self, request, pk=None):
        """New signing secret, effective for every delivery from now on (e.g. after the old one leaked)."""
        hook = self.get_object()
        hook.secret = generate_secret()
        hook.save(update_fields=["secret"])
        record(request, "webhook.secret_rotated", hook, emit_event=False)  # the secret itself isn't logged
        return Response(self.get_serializer(hook).data)

    @action(detail=True, methods=["get"])
    def deliveries(self, request, pk=None):
        hook = self.get_object()
        qs = WebhookDelivery.objects.filter(workspace=request.workspace, webhook=hook)[:50]
        return Response(WebhookDeliverySerializer(qs, many=True).data)

    @action(detail=True, methods=["post"])
    def redeliver(self, request, pk=None):
        """`{delivery}`: send that delivery's event again, as a new delivery with the same payload."""
        hook = self.get_object()
        original = WebhookDelivery.objects.filter(workspace=request.workspace, webhook=hook,
                                                  pk=request.data.get("delivery")).first() \
            if str(request.data.get("delivery", "")).isdigit() else None
        if original is None:
            raise ValidationError({"delivery": "Choose a delivery of this webhook."})
        delivery = queue_delivery(hook, original.event, original.payload["data"], payload=original.payload)
        return Response({"queued": 1, "delivery": delivery.id}, status=202)


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
