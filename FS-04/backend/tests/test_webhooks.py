import hashlib
import hmac
from datetime import timedelta
from unittest import mock

import pytest
import requests
from celery.exceptions import Retry
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

from apps.audit.models import AuditLog
from apps.integrations.models import WEBHOOK_EVENTS, Notification, WebhookDelivery
from apps.integrations.tasks import delete_old_webhook_deliveries, deliver_webhook, send_due_date_reminders
from apps.integrations.urlsafety import UnsafeURL, check_url
from apps.tenancy.models import Membership, Role

pytestmark = pytest.mark.django_db


class FakeResp:
    def __init__(self, code, text="ok"):
        self.status_code = code
        self.text = text


@pytest.fixture
def hook(api):
    r = api.post("/api/webhooks/", {"url": "https://hooks.example.com/in"}, format="json")
    assert r.status_code == 201, r.data
    return r.data


def ping(api, hook, response, django_capture_on_commit_callbacks):
    """Queue a ping and run the delivery task once with `response` (a FakeResp or an exception)."""
    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        api.post(f"/api/webhooks/{hook['id']}/ping/")
    kwargs = {"side_effect": response} if isinstance(response, Exception) else {"return_value": response}
    with mock.patch("apps.integrations.tasks.requests.post", **kwargs) as post, \
            mock.patch("apps.integrations.tasks.deliver_webhook.retry", side_effect=Retry()) as retry:
        try:
            callbacks[0]()
        except Retry:
            pass
    return post, retry, WebhookDelivery.objects.latest("id")


# --- 1. no requests into our own network (SSRF) -----------------------------------------


@pytest.mark.parametrize("url", [
    "http://localhost:8000/admin/", "http://127.0.0.1/", "http://10.0.0.5/hook", "http://192.168.1.10/",
    "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://db:5432/", "http://redis/",
    "ftp://files.example.com/", "https://user:pass@example.com/", "http://app.localhost/",
])
def test_internal_or_odd_urls_are_refused(url):
    with pytest.raises(UnsafeURL):
        check_url(url)


def test_public_urls_pass_and_private_ones_can_be_allowed_for_local_testing(settings):
    check_url("https://hooks.example.com/in")
    check_url("http://93.184.215.14/hook")
    settings.WEBHOOK_ALLOW_PRIVATE_URLS = True
    check_url("http://localhost:9000/")


def test_api_rejects_internal_webhook_urls(api):
    r = api.post("/api/webhooks/", {"url": "http://169.254.169.254/latest/meta-data/"}, format="json")
    assert r.status_code == 400 and "url" in r.data
    assert api.post("/api/webhooks/", {"url": "http://backend:8000/api/"}, format="json").status_code == 400


def test_delivery_blocked_when_host_resolves_to_a_private_address(api, hook, monkeypatch,
                                                                  django_capture_on_commit_callbacks):
    # e.g. the receiver's DNS was changed after the webhook was saved
    monkeypatch.setattr("apps.integrations.urlsafety.resolve", lambda host: {"10.1.2.3"})
    post, retry, d = ping(api, hook, FakeResp(200), django_capture_on_commit_callbacks)
    post.assert_not_called()
    retry.assert_not_called()  # it won't become safe by retrying
    assert not d.success and d.response_body.startswith("Not sent:")


def test_dns_failure_is_retried(api, hook, monkeypatch, django_capture_on_commit_callbacks):
    def no_dns(host):
        raise OSError("temporary failure in name resolution")

    monkeypatch.setattr("apps.integrations.urlsafety.resolve", no_dns)
    post, retry, d = ping(api, hook, FakeResp(200), django_capture_on_commit_callbacks)
    post.assert_not_called()
    retry.assert_called_once()  # unlike a private address, DNS may work again later
    assert d.response_body == "Not sent: Couldn't resolve hooks.example.com."


def test_redirects_are_not_followed(api, hook, django_capture_on_commit_callbacks):
    post, retry, d = ping(api, hook, FakeResp(302, ""), django_capture_on_commit_callbacks)
    assert post.call_args.kwargs["allow_redirects"] is False
    assert not d.success and d.status_code == 302
    retry.assert_not_called()


# --- 2. retry only what can succeed later -----------------------------------------------


@pytest.mark.parametrize("response, retried", [
    (FakeResp(503), True), (FakeResp(429), True), (FakeResp(408), True),
    (requests.ConnectionError("refused"), True), (requests.Timeout("slow"), True),
    (FakeResp(404), False), (FakeResp(400), False), (FakeResp(410), False),
])
def test_retry_policy(api, hook, response, retried, django_capture_on_commit_callbacks):
    _, retry, d = ping(api, hook, response, django_capture_on_commit_callbacks)
    assert retry.called is retried
    assert d.attempts == 1 and not d.success


def test_retries_stop_after_five_attempts(api, hook, django_capture_on_commit_callbacks):
    _, _, d = ping(api, hook, FakeResp(503), django_capture_on_commit_callbacks)
    WebhookDelivery.objects.filter(pk=d.pk).update(attempts=4)
    with mock.patch("apps.integrations.tasks.requests.post", return_value=FakeResp(503)), \
            mock.patch("apps.integrations.tasks.deliver_webhook.retry", side_effect=Retry()) as retry:
        deliver_webhook(d.pk)
    retry.assert_not_called()
    assert WebhookDelivery.objects.get(pk=d.pk).attempts == 5


# --- 3. the event list matches what the app sends -------------------------------------------


def test_event_catalogue_matches_emitted_events(api, project, statuses, workspace, add_member, client_for, make_user,
                                                new_issue, move, new_sprint, monkeypatch):
    emitted = set()
    real_emit = __import__("apps.integrations.events", fromlist=["emit"]).emit
    monkeypatch.setattr("apps.integrations.events.emit",
                        lambda ws, event, data: emitted.add(event) or real_emit(ws, event, data))

    # workflows, statuses, transitions
    wf = api.post("/api/workflows/", {"name": "Support"}, format="json").data
    api.patch(f"/api/workflows/{wf['id']}/", {"name": "Support desk"}, format="json")
    s1 = api.post("/api/statuses/", {"workflow": wf["id"], "name": "Open"}, format="json").data
    s2 = api.post("/api/statuses/", {"workflow": wf["id"], "name": "Closed"}, format="json").data
    api.patch(f"/api/statuses/{s1['id']}/", {"name": "New"}, format="json")
    t = api.post("/api/transitions/", {"workflow": wf["id"], "from_status": s1["id"], "to_status": s2["id"]},
                 format="json").data
    api.delete(f"/api/transitions/{t['id']}/")
    api.delete(f"/api/statuses/{s2['id']}/")
    api.delete(f"/api/workflows/{wf['id']}/")
    # projects and boards
    p2 = api.post("/api/projects/", {"key": "OPS", "name": "Ops"}, format="json").data
    api.patch(f"/api/projects/{p2['id']}/", {"name": "Operations"}, format="json")
    b = api.post("/api/boards/", {"project": p2["id"], "name": "Extra"}, format="json").data
    api.patch(f"/api/boards/{b['id']}/", {"name": "Extra board"}, format="json")
    api.delete(f"/api/boards/{b['id']}/")
    api.delete(f"/api/projects/{p2['id']}/")
    # sprints
    s = new_sprint(api, project)
    api.patch(f"/api/sprints/{s['id']}/", {"goal": "Ship it"}, format="json")
    api.post(f"/api/sprints/{s['id']}/start/")
    api.post(f"/api/sprints/{s['id']}/complete/")
    api.delete(f"/api/sprints/{s['id']}/")
    # issues, comments, attachments
    issue = new_issue(api, project)
    api.patch(f"/api/issues/{issue['id']}/", {"title": "Renamed"}, format="json")
    move(api, issue["id"], statuses[1])
    c = api.post("/api/comments/", {"issue": issue["id"], "body": "hi"}, format="json").data
    api.patch(f"/api/comments/{c['id']}/", {"body": "hello"}, format="json")
    api.delete(f"/api/comments/{c['id']}/")
    a = api.post("/api/attachments/", {"issue": issue["id"], "file": SimpleUploadedFile("a.txt", b"x")},
                 format="multipart").data
    api.delete(f"/api/attachments/{a['id']}/")
    api.delete(f"/api/issues/{issue['id']}/")
    # members
    make_user("new@acme.test")
    m = api.post("/api/members/", {"email": "new@acme.test", "role": "member"}, format="json").data
    api.patch(f"/api/members/{m['id']}/", {"role": "viewer"}, format="json")
    api.delete(f"/api/members/{m['id']}/")
    leaver = add_member("leaver@acme.test", Role.MEMBER)
    client_for(leaver, workspace).post("/api/members/leave/")

    assert emitted == set(WEBHOOK_EVENTS)


def test_webhook_can_subscribe_to_member_events(api):
    r = api.post("/api/webhooks/", {"url": "https://hooks.example.com/in", "events": ["member.added", "sprint.created"]},
                 format="json")
    assert r.status_code == 201 and r.data["events"] == ["member.added", "sprint.created"]


# --- 4. managing webhooks ---------------------------------------------------------------------


def test_rotate_secret_audits_without_logging_the_secret(api, hook, django_capture_on_commit_callbacks):
    r = api.post(f"/api/webhooks/{hook['id']}/rotate_secret/")
    assert r.status_code == 200 and r.data["secret"] != hook["secret"] and r.data["secret"].startswith("whsec_")
    entry = AuditLog.objects.get(action="webhook.secret_rotated")
    assert r.data["secret"] not in str(entry.changes) and hook["secret"] not in str(entry.changes)

    post, _, _ = ping(api, hook, FakeResp(200), django_capture_on_commit_callbacks)
    body = post.call_args.kwargs["data"]
    new_sig = "sha256=" + hmac.new(r.data["secret"].encode(), body, hashlib.sha256).hexdigest()
    assert post.call_args.kwargs["headers"]["X-TaskFlow-Signature"] == new_sig


def test_webhook_changes_are_audited(api, hook):
    api.patch(f"/api/webhooks/{hook['id']}/", {"is_active": False}, format="json")
    assert AuditLog.objects.get(action="webhook.updated").changes == {"is_active": [True, False]}
    api.delete(f"/api/webhooks/{hook['id']}/")
    assert AuditLog.objects.filter(action="webhook.deleted", changes__url=hook["url"]).exists()


def test_failed_delivery_shows_response_and_can_be_redelivered(api, hook, django_capture_on_commit_callbacks):
    _, _, failed = ping(api, hook, FakeResp(404, "no such hook"), django_capture_on_commit_callbacks)
    log = api.get(f"/api/webhooks/{hook['id']}/deliveries/").data
    assert log[0]["response_body"] == "no such hook" and log[0]["status_code"] == 404

    with mock.patch("apps.integrations.tasks.requests.post", return_value=FakeResp(200)), \
            django_capture_on_commit_callbacks(execute=True):
        r = api.post(f"/api/webhooks/{hook['id']}/redeliver/", {"delivery": failed.id}, format="json")
    assert r.status_code == 202
    again = WebhookDelivery.objects.get(pk=r.data["delivery"])
    assert again.success and again.payload == failed.payload and again.event == "ping"

    assert api.post(f"/api/webhooks/{hook['id']}/redeliver/", {"delivery": 999999}, format="json").status_code == 400


# --- 5. housekeeping jobs -----------------------------------------------------------------------


def test_old_deliveries_are_cleaned_up(api, hook, settings, django_capture_on_commit_callbacks):
    settings.WEBHOOK_DELIVERY_RETENTION_DAYS = 30
    _, _, old = ping(api, hook, FakeResp(200), django_capture_on_commit_callbacks)
    _, _, recent = ping(api, hook, FakeResp(200), django_capture_on_commit_callbacks)
    WebhookDelivery.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=31))
    assert delete_old_webhook_deliveries() == 1
    assert list(WebhookDelivery.objects.values_list("id", flat=True)) == [recent.id]


def test_due_date_reminders_are_sent_once_a_day(api, project, member, new_issue, django_capture_on_commit_callbacks):
    tomorrow = (timezone.localdate() + timedelta(days=1)).isoformat()
    new_issue(api, project, title="Due", assignee=member.id, due_date=tomorrow)
    with django_capture_on_commit_callbacks(execute=True):
        assert send_due_date_reminders() == 1
        assert send_due_date_reminders() == 0  # e.g. Beat restarted and ran the job again
    assert Notification.objects.filter(user=member, verb="due_soon").count() == 1
    assert Membership.objects.filter(user=member).exists()
