import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from apps.audit.models import AuditLog
from apps.integrations.models import Notification
from apps.tenancy.models import Membership, Role, Workspace
from apps.tenancy.services import create_workspace
from apps.tracker.models import Issue, StatusCategory, WorkflowStatus

pytestmark = pytest.mark.django_db


@pytest.fixture
def issue_obj(new_issue):
    """Like the shared `new_issue` fixture, but returns the Issue model so tests can refresh_from_db()."""
    return lambda client, project, **fields: Issue.objects.get(pk=new_issue(client, project, **fields)["id"])


def mark_done(issue):
    done = WorkflowStatus.objects.filter(workflow=issue.status.workflow, category=StatusCategory.DONE).first()
    Issue.objects.filter(pk=issue.pk).update(status=done)


# --- 1. removed members ----------------------------------------------------------


def test_removing_member_unassigns_open_issues_and_stops_notifications(api, project, workspace, add_member,
                                                                     client_for, issue_obj):
    m = add_member("leaver@acme.test", Role.MEMBER)
    open_issue = issue_obj(api, project, assignee=m.id)
    done_issue = issue_obj(api, project, assignee=m.id)
    mark_done(done_issue)
    reported = issue_obj(client_for(m, workspace), project)  # m is the reporter

    membership = Membership.objects.get(workspace=workspace, user=m)
    assert api.delete(f"/api/members/{membership.id}/").status_code == 204

    open_issue.refresh_from_db()
    done_issue.refresh_from_db()
    assert open_issue.assignee is None
    assert done_issue.assignee == m  # history kept for finished work
    entry = AuditLog.objects.get(action="member.removed")
    assert entry.changes == {"email": "leaver@acme.test", "unassigned_issues": [open_issue.key]}
    assert entry.entity_id == str(membership.id)

    # The ex-member is still the reporter of an issue, but hears nothing about new comments on it.
    Notification.objects.all().delete()
    api.post("/api/comments/", {"issue": reported.id, "body": "Still open?"}, format="json")
    api.post("/api/comments/", {"issue": done_issue.id, "body": "Reopening"}, format="json")
    assert not Notification.objects.filter(user=m).exists()


# --- 2. only the owner manages admins ----------------------------------------------


def test_only_owner_can_grant_change_or_remove_admin(api, workspace, add_member, make_user, client_for):
    a1 = add_member("a1@acme.test", Role.ADMIN)
    a2 = add_member("a2@acme.test", Role.ADMIN)
    mm = add_member("mm@acme.test", Role.MEMBER)
    make_user("new1@acme.test")
    make_user("new2@acme.test")
    a2_m = Membership.objects.get(user=a2)
    mm_m = Membership.objects.get(user=mm)
    admin = client_for(a1, workspace)

    assert admin.patch(f"/api/members/{a2_m.id}/", {"role": "member"}, format="json").status_code == 403
    assert admin.delete(f"/api/members/{a2_m.id}/").status_code == 403
    assert admin.patch(f"/api/members/{mm_m.id}/", {"role": "admin"}, format="json").status_code == 403
    assert admin.post("/api/members/", {"email": "new1@acme.test", "role": "admin"}, format="json").status_code == 403
    # Admins still manage members and viewers.
    assert admin.patch(f"/api/members/{mm_m.id}/", {"role": "viewer"}, format="json").status_code == 200
    assert admin.post("/api/members/", {"email": "new1@acme.test", "role": "viewer"}, format="json").status_code == 201

    assert api.patch(f"/api/members/{a2_m.id}/", {"role": "member"}, format="json").status_code == 200
    a1_m = Membership.objects.get(user=a1)
    assert api.delete(f"/api/members/{a1_m.id}/").status_code == 204  # also frees a seat on the Free plan
    assert api.post("/api/members/", {"email": "new2@acme.test", "role": "admin"}, format="json").status_code == 201


# --- 3. tenant comes from the header only ------------------------------------------


def test_workspace_query_parameter_is_ignored(owner, workspace):
    c = APIClient()
    c.force_authenticate(owner)
    r = c.get(f"/api/projects/?workspace={workspace.slug}")
    assert r.status_code == 400 and "X-Workspace" in str(r.data)


# --- 4. leave a workspace ----------------------------------------------------------


def test_member_can_leave(api, project, workspace, add_member, client_for, issue_obj):
    m = add_member("quitter@acme.test", Role.VIEWER)
    issue = issue_obj(api, project, assignee=m.id)
    c = client_for(m, workspace)

    assert c.post("/api/members/leave/").status_code == 204
    assert not Membership.objects.filter(workspace=workspace, user=m).exists()
    issue.refresh_from_db()
    assert issue.assignee is None
    assert AuditLog.objects.filter(action="member.left", changes__email="quitter@acme.test").exists()
    assert c.get("/api/projects/").status_code == 404


def test_owner_cannot_leave(api):
    r = api.post("/api/members/leave/")
    assert r.status_code == 400 and "Transfer ownership" in str(r.data)


# --- 5. transfer ownership ---------------------------------------------------------


def test_owner_transfers_ownership(api, owner, workspace, add_member, make_user, client_for):
    m = add_member("heir@acme.test", Role.MEMBER)
    admin = add_member("adm@acme.test", Role.ADMIN)
    outsider = make_user("out@globex.test")
    url = f"/api/workspaces/{workspace.slug}/transfer/"

    assert client_for(admin).post(url, {"user_id": m.id}, format="json").status_code == 403
    assert api.post(url, {"user_id": outsider.id}, format="json").status_code == 400
    assert api.post(url, {"user_id": owner.id}, format="json").status_code == 400
    assert api.post(url, {"user_id": "abc"}, format="json").status_code == 400

    r = api.post(url, {"user_id": m.id}, format="json")
    assert r.status_code == 200 and r.data["role"] == "admin"
    workspace.refresh_from_db()
    assert workspace.owner == m
    roles = dict(Membership.objects.filter(workspace=workspace).values_list("user__email", "role"))
    assert roles["heir@acme.test"] == "owner" and roles["owner@acme.test"] == "admin"
    assert list(Membership.objects.filter(workspace=workspace, role=Role.OWNER)) == [
        Membership.objects.get(user=m)]
    assert AuditLog.objects.get(action="workspace.ownership_transferred").changes == {
        "owner": ["owner@acme.test", "heir@acme.test"]}

    # The new owner has the owner's powers; the old owner no longer does.
    assert client_for(owner).delete(f"/api/workspaces/{workspace.slug}/").status_code == 403
    assert client_for(owner, workspace).post("/api/members/leave/").status_code == 204
    assert client_for(m).delete(f"/api/workspaces/{workspace.slug}/").status_code == 204


# --- 6. slug collisions ------------------------------------------------------------


def test_create_workspace_retries_when_slug_is_taken_concurrently(workspace, make_user, monkeypatch):
    from apps.tenancy import services

    real = services.unique_slug
    calls = []

    def racing_unique_slug(name):
        # First call returns a slug another request has just taken, as in a race.
        calls.append(name)
        return workspace.slug if len(calls) == 1 else real(name)

    monkeypatch.setattr(services, "unique_slug", racing_unique_slug)
    ws = create_workspace("Acme", make_user("second@acme.test"))
    assert ws.slug == "acme-2" and len(calls) == 2
    assert Membership.objects.filter(workspace=ws, role=Role.OWNER).count() == 1


# --- 7. workspace audit and list query -----------------------------------------------


def test_workspace_rename_is_audited_and_admin_only(api, workspace, add_member, client_for):
    m = add_member("m@acme.test", Role.MEMBER)
    url = f"/api/workspaces/{workspace.slug}/"
    assert client_for(m).patch(url, {"name": "Hijacked"}, format="json").status_code == 403
    assert api.patch(url, {"name": "Acme Corp"}, format="json").status_code == 200
    entry = AuditLog.objects.get(action="workspace.updated")
    assert entry.workspace == workspace and entry.changes == {"name": ["Acme", "Acme Corp"]}


def test_workspace_list_shows_your_role_with_constant_queries(owner, make_user, client_for):
    c = client_for(owner)

    def list_queries():
        with CaptureQueriesContext(connection) as ctx:
            r = c.get("/api/workspaces/")
        assert r.status_code == 200
        return len(ctx), {w["slug"]: w["role"] for w in r.data["results"]}

    create_workspace("One", owner)
    before, _ = list_queries()

    for i, role in enumerate([Role.ADMIN, Role.VIEWER]):
        other = create_workspace(f"Other {i}", make_user(f"boss{i}@x.test"))
        Membership.objects.create(workspace=other, user=owner, role=role)
        for j in range(5):
            Membership.objects.create(workspace=other, user=make_user(f"u{i}{j}@x.test"), role=Role.MEMBER)
    after, roles = list_queries()

    assert after == before
    assert roles == {"one": "owner", "other-0": "admin", "other-1": "viewer"}


def test_admin_forms_keep_one_owner(owner, workspace, make_user):
    from django.contrib.admin.sites import site

    from apps.tenancy.admin import MembershipForm

    other = make_user("x@acme.test")
    form = MembershipForm(data={"workspace": workspace.id, "user": other.id, "role": "owner"})
    assert not form.is_valid() and "role" in form.errors

    owner_m = Membership.objects.get(workspace=workspace, user=owner)
    form = MembershipForm(data={"workspace": workspace.id, "user": owner.id, "role": "admin"}, instance=owner_m)
    assert not form.is_valid() and "role" in form.errors

    model_admin = site._registry[Membership]
    assert model_admin.has_delete_permission(request=type("R", (), {"user": owner})(), obj=owner_m) is False
    assert Workspace.objects.filter(pk=workspace.pk).exists()
