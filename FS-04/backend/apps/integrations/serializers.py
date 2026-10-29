from rest_framework import serializers

from .models import WEBHOOK_EVENTS, Notification, Report, Webhook, WebhookDelivery
from .urlsafety import UnsafeURL, check_url


class WebhookSerializer(serializers.ModelSerializer):
    events = serializers.ListField(child=serializers.ChoiceField(choices=WEBHOOK_EVENTS), required=False)

    class Meta:
        model = Webhook
        fields = ["id", "url", "events", "secret", "is_active", "created_at"]
        read_only_fields = ["secret", "created_at"]

    def validate_url(self, value):
        # The host's DNS is checked again before every delivery (see urlsafety.py).
        try:
            check_url(value)
        except UnsafeURL as exc:
            raise serializers.ValidationError(str(exc)) from exc
        return value


class WebhookDeliverySerializer(serializers.ModelSerializer):
    class Meta:
        model = WebhookDelivery
        fields = ["id", "webhook", "event", "payload", "status_code", "response_body", "success", "attempts",
                  "created_at", "delivered_at"]


class NotificationSerializer(serializers.ModelSerializer):
    issue_key = serializers.SerializerMethodField()
    project = serializers.IntegerField(source="issue.project_id", read_only=True, default=None)

    class Meta:
        model = Notification
        fields = ["id", "verb", "message", "issue", "issue_key", "project", "read", "created_at"]
        read_only_fields = ["verb", "message", "issue", "created_at"]

    def get_issue_key(self, obj):
        return obj.issue.key if obj.issue_id else None


class ReportSerializer(serializers.ModelSerializer):
    class Meta:
        model = Report
        fields = ["id", "kind", "data", "created_at"]
