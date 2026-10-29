import csv
import io
from datetime import timedelta

import pytest
from django.test import Client, RequestFactory
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AppendOnlyError, AuditLog
from apps.audit.services import client_ip
from apps.tenancy.models import Role
from apps.tenancy.services import delete_workspace

pytestmark = pytest.mark.django_db


# --- 1. trustworthy client IP ----------------------------------------------------------


@pytest.mark.parametrize("trusted, forwarded, expected", [
    (0, "1.2.3.4", "10.0.0.5"),                    # no proxy: the header is ignored
    (1, "1.2.3.4, 203.0.113.9", "203.0.113.9"),    # browser-sent value on the left is ignored
    (1, "203.0.113.9", "203.0.113.9"),
    (1, None, "10.0.0.5"),                         # proxy configured but no header: the direct peer
    (2, "1.2.3.4, 198.51.100.7, 172.18.0.8", "198.51.100.7"),
    (1, "not-an-ip", None),
])
def test_client_ip_uses_the_address_our_proxy_saw(settings, trusted, forwarded, expected):
    settings.TRUSTED_PROXY_COUNT = trusted
    extra = {"HTTP_X_FORWARDED_FOR": forwarded} if forwarded else {}
    request = RequestFactory().get("/", REMOTE_ADDR="10.0.0.5", **extra)
    assert client_ip(request) == expected


def test_spoofed_forwarded_for_is_not_recorded(api, settings):
    settings.TRUSTED_PROXY_COUNT = 1
    r = api.post("/api/projects/", {"key": "IP", "name": "IP test"}, format="json",
                 HTTP_X_FORWARDED_FOR="6.6.6.6, 203.0.113.9")
    assert r.status_code == 201
    assert AuditLog.objects.get(action="project.created").ip_address == "203.0.113.9"


def test_login_rate_limit_ignores_spoofed_forwarded_for(owner, monkeypatch):
    from rest_framework.throttling import ScopedRateThrottle

    monkeypatch.setitem(ScopedRateThrottle.THROTTLE_RATES, "auth", "3/minute")
    codes = [
        APIClient().post("/api/auth/token/", {"email": owner.email, "password": "wrong"}, format="json",
                         HTTP_X_FORWARDED_FOR=f"9.9.9.{i}").status_code
        for i in range(4)
    ]
    assert codes == [401, 401, 401, 429]  # a new fake IP per attempt doesn't reset the limit


# --- 2. append-only -----------------------------------------------------------------------


@pytest.fixture
def entry(api, project):
    return AuditLog.objects.get(action="project.created")


def test_entries_cannot_be_changed_or_deleted(entry):
    entry.action = "project.hidden"
    with pytest.raises(AppendOnlyError):
        entry.save()
    with pytest.raises(AppendOnlyError):
        entry.delete()
    with pytest.raises(AppendOnlyError):
        AuditLog.objects.filter(pk=entry.pk).update(action="x")
    with pytest.raises(AppendOnlyError):
        AuditLog.objects.filter(pk=entry.pk).delete()
    assert AuditLog.objects.get(pk=entry.pk).action == "project.created"


def test_deleting_workspace_still_removes_its_entries(entry, workspace):
    delete_workspace(workspace)
    assert not AuditLog.objects.filter(pk=entry.pk).exists()


def test_admin_is_read_only(owner, entry):
    owner.is_staff = owner.is_superuser = True
    owner.save()
    c = Client()
    c.force_login(owner)
    assert c.get("/admin/audit/auditlog/").status_code == 200
    assert c.get(f"/admin/audit/auditlog/{entry.pk}/change/").status_code == 200  # view only
    assert c.post(f"/admin/audit/auditlog/{entry.pk}/change/", {"action": "x"}).status_code == 403
    assert c.get("/admin/audit/auditlog/add/").status_code == 403
    assert c.post(f"/admin/audit/auditlog/{entry.pk}/delete/", {"post": "yes"}).status_code == 403
    assert AuditLog.objects.filter(pk=entry.pk, action="project.created").exists()


# --- 3. actor email is kept --------------------------------------------------------------


def test_entry_keeps_actor_email_after_user_is_deleted(add_member, client_for, workspace, project):
    m = add_member("leaving@acme.test", Role.MEMBER)
    client_for(m, workspace).post("/api/issues/", {"project": project["id"], "title": "x"}, format="json")
    entry = AuditLog.objects.get(action="issue.created")
    assert entry.actor == m and entry.actor_email == "leaving@acme.test"

    m.delete()
    entry.refresh_from_db()
    assert entry.actor is None and entry.actor_email == "leaving@acme.test"


# --- 5. filters, paging, IP visibility ------------------------------------------------------


@pytest.fixture
def busy_log(api, project, add_member, client_for, workspace):
    """A project, a sprint, two issues (one by a member) and a member added."""
    api.post("/api/sprints/", {"project": project["id"], "name": "S1"}, format="json")
    api.post("/api/issues/", {"project": project["id"], "title": "Owner issue"}, format="json")
    m = add_member("meera@acme.test", Role.MEMBER)
    client_for(m, workspace).post("/api/issues/", {"project": project["id"], "title": "Meera issue"}, format="json")
    return m


def actions(api, query):
    r = api.get(f"/api/audit-logs/?{query}")
    assert r.status_code == 200, r.data
    return [e["action"] for e in r.data["results"]]


def test_filter_by_kind_person_search_and_dates(api, busy_log):
    assert set(actions(api, "kind=issue")) == {"issue.created"}
    assert actions(api, "kind=sprint") == ["sprint.created"]
    assert actions(api, "actor_email=MEERA@acme.test") == ["issue.created"]  # case-insensitive
    assert actions(api, "search=meera@acme") == ["issue.created"]  # search covers the person too

    today = timezone.now().date()
    assert len(actions(api, f"since={today}&until={today}")) == AuditLog.objects.count()
    assert actions(api, f"until={today - timedelta(days=1)}") == []


def test_list_pages_and_shows_ip_only_to_admins(api, busy_log, client_for, workspace, project):
    r = api.get("/api/audit-logs/?limit=2&offset=0")
    assert r.data["count"] == AuditLog.objects.count() and len(r.data["results"]) == 2
    assert "ip_address" in r.data["results"][0]

    issue_id = AuditLog.objects.filter(action="issue.created").first().entity_id
    history = client_for(busy_log, workspace).get(f"/api/issues/{issue_id}/history/").data
    assert history and "ip_address" not in history[0]


# --- 6. CSV export --------------------------------------------------------------------------


def test_export_csv_respects_filters_and_neutralises_formulas(api, project, add_member, client_for, workspace):
    api.post("/api/issues/", {"project": project["id"], "title": "Normal issue"}, format="json")
    # A sprint's audit label is its bare name, so a name that looks like a spreadsheet formula starts the cell.
    api.post("/api/sprints/", {"project": project["id"], "name": "=HYPERLINK(\"http://evil\")"}, format="json")

    r = api.get("/api/audit-logs/export/?kind=issue")
    assert r.status_code == 200 and r["Content-Type"].startswith("text/csv")
    assert 'filename="audit-log-acme.csv"' in r["Content-Disposition"]
    rows = list(csv.reader(io.StringIO(r.content.decode())))
    assert rows[0][:3] == ["time (UTC)", "who", "action"]
    assert [row[2] for row in rows[1:]] == ["issue.created"]
    assert rows[1][1] == "owner@acme.test"

    rows = list(csv.reader(io.StringIO(api.get("/api/audit-logs/export/?kind=sprint").content.decode())))
    assert rows[1][5] == "'=HYPERLINK(\"http://evil\")"  # opened in Excel, it's text, not a live formula

    member = add_member("m@acme.test", Role.MEMBER)
    assert client_for(member, workspace).get("/api/audit-logs/export/").status_code == 403
