import hashlib
import hmac
import json
from unittest import mock

import pytest
from django.core import mail

from apps.integrations.models import Report, WebhookDelivery
from apps.integrations.tasks import send_due_date_reminders

pytestmark = pytest.mark.django_db


class FakeResp:
    def __init__(self, code):
        self.status_code = code
        self.text = "ok"


def test_webhook_delivery_is_signed(api, project, django_capture_on_commit_callbacks):
    hook = api.post("/api/webhooks/", {"url": "https://example.com/hook", "events": ["issue.created"]},
                    format="json").data
    with mock.patch("apps.integrations.tasks.requests.post", return_value=FakeResp(200)) as post, \
            django_capture_on_commit_callbacks(execute=True):
        api.post("/api/issues/", {"project": project["id"], "title": "Hooked"}, format="json")
    assert post.call_count == 1
    body = post.call_args.kwargs["data"]
    headers = post.call_args.kwargs["headers"]
    expected = "sha256=" + hmac.new(hook["secret"].encode(), body, hashlib.sha256).hexdigest()
    assert headers["X-TaskFlow-Signature"] == expected
    assert json.loads(body)["event"] == "issue.created"
    d = WebhookDelivery.objects.get()
    assert d.success and d.attempts == 1


def test_webhook_not_sent_for_unsubscribed_event(api, project, django_capture_on_commit_callbacks):
    api.post("/api/webhooks/", {"url": "https://example.com/hook", "events": ["comment.created"]}, format="json")
    with mock.patch("apps.integrations.tasks.requests.post") as post, \
            django_capture_on_commit_callbacks(execute=True):
        api.post("/api/issues/", {"project": project["id"], "title": "x"}, format="json")
    post.assert_not_called()


def test_webhook_failure_retries(api, project, django_capture_on_commit_callbacks):
    from celery.exceptions import Retry

    api.post("/api/webhooks/", {"url": "https://example.com/hook"}, format="json")
    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        api.post("/api/issues/", {"project": project["id"], "title": "x"}, format="json")
    with mock.patch("apps.integrations.tasks.requests.post", return_value=FakeResp(500)), \
            mock.patch("apps.integrations.tasks.deliver_webhook.retry", side_effect=Retry()) as retry:
        with pytest.raises(Retry):
            callbacks[0]()
    retry.assert_called_once()
    d = WebhookDelivery.objects.get()
    assert not d.success and d.status_code == 500


def test_webhooks_require_admin(workspace, add_member, client_for):
    m = add_member("m@acme.test", "member")
    assert client_for(m, workspace).get("/api/webhooks/").status_code == 403


def test_report_generation(api, project, workspace):
    api.post("/api/issues/", {"project": project["id"], "title": "x"}, format="json")
    r = api.post("/api/reports/generate/")
    assert r.status_code == 202
    report = Report.objects.get(workspace=workspace)
    assert report.data["created"] == 1 and report.data["open_total"] == 1
    assert any("Weekly summary" in m.subject for m in mail.outbox)
    assert api.get("/api/reports/").data["results"][0]["id"] == report.id


def test_due_date_reminders(api, project, member, django_capture_on_commit_callbacks):
    from datetime import timedelta

    from django.utils import timezone

    tomorrow = (timezone.localdate() + timedelta(days=1)).isoformat()
    api.post("/api/issues/", {"project": project["id"], "title": "Due", "assignee": member.id,
                              "due_date": tomorrow}, format="json")
    with django_capture_on_commit_callbacks(execute=True):
        assert send_due_date_reminders() == 1
    assert member.notifications.filter(verb="due_soon").exists()
