import os

import pytest
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, connection, transaction
from django.db.models import QuerySet
from django.test import Client
from django.test.utils import CaptureQueriesContext

from apps.tenancy.services import create_workspace, delete_workspace
from apps.tracker.models import Attachment, Issue, Project, Sprint, Workflow, WorkflowStatus

pytestmark = pytest.mark.django_db


# --- 1. one active sprint per project ------------------------------------------------


def test_database_allows_only_one_active_sprint(api, project, new_sprint):
    s1, s2 = new_sprint(api, project), new_sprint(api, project)
    assert api.post(f"/api/sprints/{s1['id']}/start/").status_code == 200
    with pytest.raises(IntegrityError), transaction.atomic():
        Sprint.objects.filter(pk=s2["id"]).update(state=Sprint.State.ACTIVE)


def test_concurrent_start_gets_400_not_500(api, project, monkeypatch, new_sprint):
    s1, s2 = new_sprint(api, project), new_sprint(api, project)
    assert api.post(f"/api/sprints/{s1['id']}/start/").status_code == 200
    # Simulate the race: the second request's "already active?" check runs before the first commits.
    real_exists = QuerySet.exists
    monkeypatch.setattr(QuerySet, "exists",
                        lambda qs: False if qs.model is Sprint else real_exists(qs))
    r = api.post(f"/api/sprints/{s2['id']}/start/")
    assert r.status_code == 400 and "already has an active sprint" in str(r.data)
    assert Sprint.objects.get(pk=s2["id"]).state == Sprint.State.PLANNED


# --- 2. one default workflow per workspace ------------------------------------------


def test_database_allows_only_one_default_workflow(workspace):
    assert Workflow.objects.filter(workspace=workspace, is_default=True).count() == 1
    with pytest.raises(IntegrityError), transaction.atomic():
        Workflow.objects.create(workspace=workspace, name="Another", is_default=True)
    Workflow.objects.create(workspace=workspace, name="Custom")  # non-default workflows are fine


# --- 3. sprint dates ---------------------------------------------------------------


def test_sprint_end_date_checked_on_partial_update(api, project, new_sprint):
    s = new_sprint(api, project, start_date="2026-11-10", end_date="2026-11-20")
    r = api.patch(f"/api/sprints/{s['id']}/", {"end_date": "2026-11-01"}, format="json")
    assert r.status_code == 400 and "end_date" in r.data
    r = api.patch(f"/api/sprints/{s['id']}/", {"start_date": "2026-11-25"}, format="json")
    assert r.status_code == 400
    assert api.patch(f"/api/sprints/{s['id']}/", {"end_date": "2026-11-10"}, format="json").status_code == 200

    with pytest.raises(IntegrityError), transaction.atomic():
        Sprint.objects.filter(pk=s["id"]).update(end_date="2026-11-01")


# --- 4. colours and project keys ------------------------------------------------------


@pytest.mark.parametrize("color, ok", [
    ("#12ab9F", True), ("url(x)", False), ("red", False), ("#12ab9", False), ("#12ab9g", False),
])
def test_status_colour_must_be_hex(api, workspace, color, ok):
    wf = Workflow.objects.get(workspace=workspace, is_default=True)
    r = api.post("/api/statuses/", {"workflow": wf.id, "name": f"S {color}", "color": color}, format="json")
    assert r.status_code == (201 if ok else 400), r.data
    if not ok:
        assert "color" in r.data


@pytest.mark.parametrize("key, saved", [("web2", "WEB2"), ("CAFÉ", None), ("A²", None), ("A-B", None)])
def test_project_key_is_ascii(api, key, saved):
    r = api.post("/api/projects/", {"key": key, "name": "P"}, format="json")
    if saved:
        assert r.status_code == 201 and r.data["key"] == saved
    else:
        assert r.status_code == 400 and "key" in r.data


# --- 5. attachment files ---------------------------------------------------------------


@pytest.fixture
def upload(api, project):
    def _upload(name="notes.txt"):
        issue = api.post("/api/issues/", {"project": project["id"], "title": "Has files"}, format="json").data
        r = api.post("/api/attachments/", {"issue": issue["id"], "file": SimpleUploadedFile(name, b"hello")},
                     format="multipart")
        assert r.status_code == 201, r.data
        att = Attachment.objects.get(pk=r.data["id"])
        assert os.path.exists(att.file.path)
        return att

    return _upload


def test_deleting_attachment_removes_file(api, upload, django_capture_on_commit_callbacks):
    att = upload()
    with django_capture_on_commit_callbacks(execute=True):
        assert api.delete(f"/api/attachments/{att.id}/").status_code == 204
    assert not os.path.exists(att.file.path)


def test_deleting_issue_or_workspace_removes_files(api, upload, workspace, django_capture_on_commit_callbacks):
    a1, a2 = upload("a.txt"), upload("b.txt")
    with django_capture_on_commit_callbacks(execute=True):
        assert api.delete(f"/api/issues/{a1.issue_id}/").status_code == 204
    assert not os.path.exists(a1.file.path) and os.path.exists(a2.file.path)

    with django_capture_on_commit_callbacks(execute=True):
        delete_workspace(workspace)
    assert not os.path.exists(a2.file.path)


def test_file_kept_when_delete_rolls_back(upload, django_capture_on_commit_callbacks):
    att = upload()
    with django_capture_on_commit_callbacks(execute=True):
        try:
            with transaction.atomic():
                att.delete()
                raise RuntimeError("abort")
        except RuntimeError:
            pass
    assert os.path.exists(att.file.path)


# --- 6. cross-tenant checks in clean() and the admin ------------------------------------------


@pytest.fixture
def globex(make_user):
    return create_workspace("Globex", make_user("owner@globex.test"))


def test_clean_rejects_links_to_another_workspace(project, workspace, globex, make_user, owner):
    p = Project.objects.get(pk=project["id"])
    foreign_status = WorkflowStatus.objects.filter(workspace=globex).first()
    outsider = make_user("out@globex.test")
    issue = Issue(workspace=workspace, project=p, number=99, title="x", status=foreign_status,
                  assignee=outsider, reporter=owner)
    with pytest.raises(ValidationError) as e:
        issue.full_clean()
    assert {"status", "assignee"} <= set(e.value.message_dict)

    own_status = WorkflowStatus.objects.filter(workspace=workspace).first()
    Issue(workspace=workspace, project=p, number=99, title="x", status=own_status, reporter=owner).full_clean()

    globex_wf = Workflow.objects.get(workspace=globex)
    with pytest.raises(ValidationError) as e:
        Project(workspace=workspace, key="X", name="X", workflow=globex_wf).full_clean()
    assert "workflow" in e.value.message_dict


@pytest.fixture
def admin_client(owner):
    owner.is_staff = owner.is_superuser = True
    owner.save()
    c = Client()
    c.force_login(owner)
    return c


def test_admin_add_issue_checks_tenant_and_numbers_it(admin_client, project, workspace, globex, owner):
    p = Project.objects.get(pk=project["id"])
    data = {"workspace": workspace.id, "project": p.id, "title": "From admin", "type": "task",
            "priority": "medium", "reporter": owner.id}

    foreign_status = WorkflowStatus.objects.filter(workspace=globex).first()
    r = admin_client.post("/admin/tracker/issue/add/", {**data, "status": foreign_status.id})
    assert r.status_code == 200 and not Issue.objects.filter(title="From admin").exists()

    own_status = WorkflowStatus.objects.filter(workspace=workspace).first()
    r = admin_client.post("/admin/tracker/issue/add/", {**data, "status": own_status.id})
    assert r.status_code == 302
    issue = Issue.objects.get(title="From admin")
    p.refresh_from_db()
    assert issue.number == p.issue_counter == 1 and issue.key == "WEB-1"


def test_admin_issue_list_has_constant_queries(admin_client, api, project):
    def queries():
        with CaptureQueriesContext(connection) as ctx:
            assert admin_client.get("/admin/tracker/issue/").status_code == 200
        return len(ctx)

    api.post("/api/issues/", {"project": project["id"], "title": "one"}, format="json")
    before = queries()
    for i in range(5):
        api.post("/api/issues/", {"project": project["id"], "title": f"more {i}"}, format="json")
    assert queries() == before


def test_admin_pages_render(admin_client, project):
    for model in ["workflow", "workflowstatus", "workflowtransition", "project", "board", "sprint", "issue",
                  "comment", "attachment"]:
        assert admin_client.get(f"/admin/tracker/{model}/").status_code == 200, model
        assert admin_client.get(f"/admin/tracker/{model}/add/").status_code == 200, model
