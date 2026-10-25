import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.audit.models import AuditLog
from apps.integrations.models import Notification
from apps.tracker.models import Issue

pytestmark = pytest.mark.django_db


def test_project_creates_board_and_default_workflow(api, project):
    assert project["board_id"]
    assert project["key"] == "WEB"
    r = api.get(f"/api/boards/{project['board_id']}/columns/")
    assert [c["status"]["name"] for c in r.data["columns"]] == ["To Do", "In Progress", "In Review", "Done"]


def test_duplicate_project_key_rejected(api, project):
    r = api.post("/api/projects/", {"key": "WEB", "name": "Again"}, format="json")
    assert r.status_code == 400


def test_issue_keys_increment_per_project(api, project):
    keys = [api.post("/api/issues/", {"project": project["id"], "title": f"i{i}"}, format="json").data["key"]
            for i in range(3)]
    assert keys == ["WEB-1", "WEB-2", "WEB-3"]


def test_issue_defaults_to_first_status_and_reporter(api, project, owner, statuses):
    r = api.post("/api/issues/", {"project": project["id"], "title": "x"}, format="json")
    assert r.data["status"] == statuses[0].id
    assert r.data["reporter_detail"]["email"] == owner.email


def test_move_reorders_and_enforces_workflow(api, project, statuses):
    todo, prog, review, done = statuses
    ids = [api.post("/api/issues/", {"project": project["id"], "title": f"t{i}"}, format="json").data["id"]
           for i in range(3)]
    # Allowed: To Do -> In Progress
    r = api.post(f"/api/issues/{ids[0]}/move/", {"status": prog.id, "index": 0}, format="json")
    assert r.status_code == 200 and r.data["status"] == prog.id
    # Not allowed by default workflow: To Do -> Done
    r = api.post(f"/api/issues/{ids[1]}/move/", {"status": done.id}, format="json")
    assert r.status_code == 400
    # Reorder within the same column
    api.post(f"/api/issues/{ids[2]}/move/", {"status": todo.id, "index": 0}, format="json")
    column = list(Issue.objects.filter(status=todo).order_by("rank").values_list("id", flat=True))
    assert column == [ids[2], ids[1]]
    assert AuditLog.objects.filter(action="issue.moved").count() == 1


def test_custom_workflow_free_movement_without_transitions(api, workspace):
    wf = api.post("/api/workflows/", {"name": "Simple"}, format="json").data
    a = api.post("/api/statuses/", {"workflow": wf["id"], "name": "Open", "order": 0}, format="json").data
    b = api.post("/api/statuses/", {"workflow": wf["id"], "name": "Closed", "category": "done", "order": 1},
                 format="json").data
    p = api.post("/api/projects/", {"key": "OPS", "name": "Ops", "workflow": wf["id"]}, format="json").data
    issue = api.post("/api/issues/", {"project": p["id"], "title": "x"}, format="json").data
    assert issue["status"] == a["id"]
    assert api.post(f"/api/issues/{issue['id']}/move/", {"status": b["id"]}, format="json").status_code == 200
    # Add a rule: only Closed -> Open. Now Open -> Closed is blocked for a new issue.
    api.post("/api/transitions/", {"workflow": wf["id"], "from_status": b["id"], "to_status": a["id"]}, format="json")
    issue2 = api.post("/api/issues/", {"project": p["id"], "title": "y"}, format="json").data
    assert api.post(f"/api/issues/{issue2['id']}/move/", {"status": b["id"]}, format="json").status_code == 400


def test_status_from_other_workflow_rejected(api, project):
    wf = api.post("/api/workflows/", {"name": "Other"}, format="json").data
    s = api.post("/api/statuses/", {"workflow": wf["id"], "name": "Foreign"}, format="json").data
    r = api.post("/api/issues/", {"project": project["id"], "title": "x", "status": s["id"]}, format="json")
    assert r.status_code == 400


def test_update_is_audited_with_diff(api, project):
    issue = api.post("/api/issues/", {"project": project["id"], "title": "Old"}, format="json").data
    api.patch(f"/api/issues/{issue['id']}/", {"title": "New", "priority": "high"}, format="json")
    log = AuditLog.objects.get(action="issue.updated")
    assert log.changes == {"title": ["Old", "New"], "priority": ["medium", "high"]}
    history = api.get(f"/api/issues/{issue['id']}/history/").data
    assert {h["action"] for h in history} == {"issue.created", "issue.updated"}


def test_comments_and_notifications(api, project, member, workspace, client_for):
    issue = api.post("/api/issues/", {"project": project["id"], "title": "x", "assignee": member.id},
                     format="json").data
    assert Notification.objects.filter(user=member, verb="assigned").count() == 1
    mc = client_for(member, workspace)
    r = mc.post("/api/comments/", {"issue": issue["id"], "body": "On it"}, format="json")
    assert r.status_code == 201
    # reporter (owner) is notified; author (member) is not
    assert Notification.objects.filter(verb="commented").values_list("user__email", flat=True).get() == "owner@acme.test"
    # member cannot edit someone else's comment
    c2 = api.post("/api/comments/", {"issue": issue["id"], "body": "Owner note"}, format="json").data
    assert mc.patch(f"/api/comments/{c2['id']}/", {"body": "hacked"}, format="json").status_code == 403
    # member: "assigned" + "commented" (by owner)
    assert mc.get("/api/notifications/unread_count/").data["count"] == 2
    mc.post("/api/notifications/mark_all_read/")
    assert mc.get("/api/notifications/unread_count/").data["count"] == 0


def test_attachments_upload_and_tenant_checked_download(api, project, make_user, client_for):
    from apps.tenancy.services import create_workspace

    issue = api.post("/api/issues/", {"project": project["id"], "title": "x"}, format="json").data
    f = SimpleUploadedFile("notes.txt", b"hello world", content_type="text/plain")
    r = api.post("/api/attachments/", {"issue": issue["id"], "file": f}, format="multipart")
    assert r.status_code == 201, r.data
    assert r.data["filename"] == "notes.txt" and r.data["size"] == 11
    resp = api.get(r.data["download_url"])
    assert resp.status_code == 200 and b"".join(resp.streaming_content) == b"hello world"
    other = make_user("o@g.test")
    g = create_workspace("G", other)
    assert client_for(other, g).get(r.data["download_url"]).status_code == 404


def test_sprint_lifecycle(api, project, statuses):
    sprint = api.post("/api/sprints/", {"project": project["id"], "name": "S1"}, format="json").data
    done_issue = api.post("/api/issues/", {"project": project["id"], "title": "a", "sprint": sprint["id"]},
                          format="json").data
    open_issue = api.post("/api/issues/", {"project": project["id"], "title": "b", "sprint": sprint["id"]},
                          format="json").data
    assert api.post(f"/api/sprints/{sprint['id']}/start/").data["state"] == "active"
    s2 = api.post("/api/sprints/", {"project": project["id"], "name": "S2"}, format="json").data
    assert api.post(f"/api/sprints/{s2['id']}/start/").status_code == 400  # one active per project
    for st in statuses[1:]:
        api.post(f"/api/issues/{done_issue['id']}/move/", {"status": st.id}, format="json")
    r = api.post(f"/api/sprints/{sprint['id']}/complete/")
    assert r.data["returned_to_backlog"] == 1
    assert Issue.objects.get(pk=open_issue["id"]).sprint_id is None
    assert Issue.objects.get(pk=done_issue["id"]).sprint_id == sprint["id"]


def test_board_columns_filter_by_sprint(api, project):
    sprint = api.post("/api/sprints/", {"project": project["id"], "name": "S1"}, format="json").data
    api.post(f"/api/sprints/{sprint['id']}/start/")
    api.post("/api/issues/", {"project": project["id"], "title": "in sprint", "sprint": sprint["id"]}, format="json")
    api.post("/api/issues/", {"project": project["id"], "title": "backlog"}, format="json")
    url = f"/api/boards/{project['board_id']}/columns/"
    count = lambda r: sum(len(c["issues"]) for c in r.data["columns"])  # noqa: E731
    assert count(api.get(url)) == 2
    assert count(api.get(url + "?sprint=active")) == 1
    assert count(api.get(url + "?sprint=backlog")) == 1


def test_project_stats(api, project):
    for i in range(3):
        api.post("/api/issues/", {"project": project["id"], "title": f"{i}", "type": "bug"}, format="json")
    r = api.get(f"/api/projects/{project['id']}/stats/")
    assert r.data["total"] == 3 and r.data["by_type"] == {"bug": 3} and r.data["by_category"]["todo"] == 3
