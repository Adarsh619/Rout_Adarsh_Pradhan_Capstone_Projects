import pytest

from apps.audit.models import AuditLog
from apps.integrations.models import Notification
from apps.tenancy.models import Role
from apps.tracker.models import Issue

pytestmark = pytest.mark.django_db


@pytest.fixture
def people(add_member, client_for, workspace):
    """A client per role, plus an issue reported by `reporter` (a plain member)."""
    users = {
        "reporter": add_member("reporter@acme.test", Role.MEMBER),
        "member": add_member("other@acme.test", Role.MEMBER),
        "admin": add_member("admin@acme.test", Role.ADMIN),
        "viewer": add_member("viewer@acme.test", Role.VIEWER),
    }
    return {name: (user, client_for(user, workspace)) for name, user in users.items()}


@pytest.fixture
def issue(people, project):
    _, reporter = people["reporter"]
    r = reporter.post("/api/issues/", {"project": project["id"], "title": "Fix login"}, format="json")
    assert r.status_code == 201, r.data
    return r.data


# --- who can delete ---------------------------------------------------------------------


@pytest.mark.parametrize("who, allowed", [("member", False), ("viewer", False), ("reporter", True)])
def test_only_reporter_among_members_can_delete(people, issue, who, allowed):
    _, client = people[who]
    r = client.delete(f"/api/issues/{issue['id']}/")
    assert r.status_code == (204 if allowed else 403)
    assert Issue.objects.filter(pk=issue["id"]).exists() is not allowed
    if who == "member":
        assert "reporter or an admin" in str(r.data)


@pytest.mark.parametrize("who", ["admin", "owner"])
def test_admin_and_owner_can_delete_anyones_issue(people, api, issue, who):
    client = api if who == "owner" else people[who][1]
    assert client.delete(f"/api/issues/{issue['id']}/").status_code == 204


def test_can_delete_is_reported_per_caller(people, api, issue, project):
    expected = {"reporter": True, "member": False, "admin": True, "viewer": False}
    for who, can in expected.items():
        _, client = people[who]
        assert client.get(f"/api/issues/{issue['id']}/").data["can_delete"] is can, who
        columns = client.get(f"/api/boards/{project['board_id']}/columns/").data["columns"]
        card = next(i for col in columns for i in col["issues"] if i["id"] == issue["id"])
        assert card["can_delete"] is can, who
    assert api.get(f"/api/issues/{issue['id']}/").data["can_delete"] is True  # owner


# --- asking an admin ----------------------------------------------------------------------


def test_member_can_ask_admins_to_delete(people, owner, issue, mailoutbox, django_capture_on_commit_callbacks):
    member, client = people["member"]
    admin, _ = people["admin"]

    with django_capture_on_commit_callbacks(execute=True):
        r = client.post(f"/api/issues/{issue['id']}/request_deletion/")
    assert r.status_code == 202 and r.data == {"notified": 2}

    notes = Notification.objects.filter(verb="delete_requested")
    assert set(notes.values_list("user", flat=True)) == {admin.id, owner.id}  # not the requester or reporter
    key = Issue.objects.get(pk=issue["id"]).key
    assert notes.first().message == f"other asked to delete {key}: Fix login"
    assert sorted(m.to[0] for m in mailoutbox) == ["admin@acme.test", "owner@acme.test"]
    entry = AuditLog.objects.get(action="issue.deletion_requested")
    assert entry.actor == member and entry.entity_id == str(issue["id"])

    # A second click doesn't notify anyone again while the first request is still unread.
    r = client.post(f"/api/issues/{issue['id']}/request_deletion/")
    assert r.status_code == 200 and r.data == {"already_requested": True}
    assert notes.count() == 2


def test_request_is_only_for_people_who_cant_delete(people, api, issue):
    assert people["reporter"][1].post(f"/api/issues/{issue['id']}/request_deletion/").status_code == 400
    assert api.post(f"/api/issues/{issue['id']}/request_deletion/").status_code == 400  # owner
    assert people["viewer"][1].post(f"/api/issues/{issue['id']}/request_deletion/").status_code == 403
    assert not Notification.objects.filter(verb="delete_requested").exists()


def test_admin_notification_links_to_the_issue(people, issue, client_for):
    people["member"][1].post(f"/api/issues/{issue['id']}/request_deletion/")
    admin, admin_client = people["admin"]
    note = admin_client.get("/api/notifications/").data["results"][0]
    assert note["verb"] == "delete_requested" and note["issue"] == issue["id"]
    assert note["project"] == issue["project"]  # the bell opens the board with this issue
