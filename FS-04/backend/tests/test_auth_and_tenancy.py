import pytest
from rest_framework.test import APIClient

from apps.tenancy.models import Role
from apps.tenancy.services import create_workspace

pytestmark = pytest.mark.django_db


def test_register_creates_user_workspace_and_tokens():
    c = APIClient()
    r = c.post("/api/auth/register/", {"email": "New@Co.test", "password": "longpassword",
                                       "workspace_name": "New Co"}, format="json")
    assert r.status_code == 201
    assert r.data["workspace"] == "new-co"
    assert r.data["access"]
    r = c.post("/api/auth/token/", {"email": "new@co.test", "password": "longpassword"}, format="json")
    assert r.status_code == 200 and "access" in r.data


def test_register_rejects_duplicate_email(owner):
    r = APIClient().post("/api/auth/register/", {"email": owner.email, "password": "longpassword"}, format="json")
    assert r.status_code == 400


def test_unauthenticated_is_rejected():
    assert APIClient().get("/api/projects/").status_code == 401


def test_workspace_header_required(owner, client_for):
    assert client_for(owner).get("/api/projects/").status_code == 400


def test_workspace_list_only_shows_memberships(owner, workspace, make_user, client_for):
    other = make_user("x@globex.test")
    create_workspace("Globex", other)
    r = client_for(owner).get("/api/workspaces/")
    assert [w["slug"] for w in r.data["results"]] == ["acme"]
    assert r.data["results"][0]["role"] == "owner"


def test_tenant_isolation(api, project, make_user, client_for):
    """A user in Globex can't see or touch Acme data, even by guessing IDs."""
    api.post("/api/issues/", {"project": project["id"], "title": "Secret Acme issue"}, format="json")
    outsider = make_user("spy@globex.test")
    globex = create_workspace("Globex", outsider)
    spy = client_for(outsider, globex)

    assert spy.get("/api/issues/").data["results"] == []
    assert spy.get(f"/api/projects/{project['id']}/").status_code == 404
    # Cannot create an issue in someone else's project
    r = spy.post("/api/issues/", {"project": project["id"], "title": "x"}, format="json")
    assert r.status_code == 400
    # Cannot impersonate the tenant via header
    spy.credentials(HTTP_X_WORKSPACE="acme")
    assert spy.get("/api/issues/").status_code == 404


def test_cannot_assign_non_member(api, project, make_user):
    stranger = make_user("stranger@x.test")
    r = api.post("/api/issues/", {"project": project["id"], "title": "t", "assignee": stranger.id}, format="json")
    assert r.status_code == 400 and "assignee" in r.data


@pytest.mark.parametrize("role,can_create_issue,can_create_project,can_view_audit", [
    (Role.VIEWER, False, False, False),
    (Role.MEMBER, True, False, False),
    (Role.ADMIN, True, True, True),
])
def test_role_permissions(role, can_create_issue, can_create_project, can_view_audit,
                          workspace, project, add_member, client_for):
    user = add_member(f"{role}@acme.test", role)
    c = client_for(user, workspace)
    assert c.get("/api/issues/").status_code == 200  # everyone can read
    r = c.post("/api/issues/", {"project": project["id"], "title": "From " + role}, format="json")
    assert (r.status_code == 201) == can_create_issue
    r = c.post("/api/projects/", {"key": "N" + role[:3].upper(), "name": "New"}, format="json")
    assert (r.status_code == 201) == can_create_project
    assert (c.get("/api/audit-logs/").status_code == 200) == can_view_audit


def test_member_management(api, workspace, make_user, add_member, client_for):
    make_user("invitee@acme.test")
    r = api.post("/api/members/", {"email": "invitee@acme.test", "role": "member"}, format="json")
    assert r.status_code == 201
    r = api.patch(f"/api/members/{r.data['id']}/", {"role": "admin"}, format="json")
    assert r.data["role"] == "admin"
    owner_m = workspace.memberships.get(role="owner")
    assert api.delete(f"/api/members/{owner_m.id}/").status_code == 403
    m = add_member("m@acme.test", Role.MEMBER)
    assert client_for(m, workspace).post("/api/members/", {"email": "x@y.z"}, format="json").status_code == 403


def test_owner_can_delete_workspace_with_data(api, project, workspace, add_member, client_for):
    api.post("/api/issues/", {"project": project["id"], "title": "x"}, format="json")
    admin = add_member("adm@acme.test", Role.ADMIN)
    assert client_for(admin).delete(f"/api/workspaces/{workspace.slug}/").status_code == 403
    assert api.delete(f"/api/workspaces/{workspace.slug}/").status_code == 204
    from apps.tenancy.models import Workspace

    assert not Workspace.objects.filter(pk=workspace.pk).exists()
