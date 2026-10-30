import pytest
from rest_framework.exceptions import ValidationError

from apps.audit.models import AuditLog
from apps.integrations.models import Notification
from apps.tracker.models import Issue
from apps.tracker.services import move_issue

pytestmark = pytest.mark.django_db


# --- 1. status edits in the issue form behave like a drag ----------------------------------


def test_status_change_in_issue_form_moves_card_to_bottom_and_notifies(api, project, statuses, member, new_issue, move):
    todo, doing = statuses[0], statuses[1]
    a, b = new_issue(api, project), new_issue(api, project)
    move(api, a["id"], doing)
    move(api, b["id"], doing)
    c = new_issue(api, project, assignee=member.id)
    Notification.objects.all().delete()

    # The issue form sends every field back, including the status picked from its dropdown.
    r = api.patch(f"/api/issues/{c['id']}/", {"title": "Renamed", "status": doing.id, "sprint": None}, format="json")
    assert r.status_code == 200, r.data
    assert r.data["status"] == doing.id and r.data["title"] == "Renamed"
    column = list(Issue.objects.filter(status=doing).order_by("rank").values_list("id", flat=True))
    assert column == [a["id"], b["id"], c["id"]]

    moved = AuditLog.objects.get(action="issue.moved", entity_id=str(c["id"]))
    assert moved.changes == {"status": [todo.name, doing.name]}
    updated = AuditLog.objects.get(action="issue.updated", entity_id=str(c["id"]))
    assert updated.changes == {"title": ["Task", "Renamed"]}  # the status change is logged once, as a move
    assert Notification.objects.filter(user=member, verb="moved").exists()


def test_status_change_in_issue_form_still_follows_workflow(api, project, statuses, new_issue):
    done = statuses[3]
    issue = new_issue(api, project)
    r = api.patch(f"/api/issues/{issue['id']}/", {"status": done.id}, format="json")
    assert r.status_code == 400 and "status" in r.data
    assert Issue.objects.get(pk=issue["id"]).status == statuses[0]


# --- 2. parents are fixed after creation -------------------------------------------------


def test_parent_links_cannot_be_changed(api, project, statuses, new_issue):
    other_wf = api.post("/api/workflows/", {"name": "Support"}, format="json").data
    other_project = api.post("/api/projects/", {"key": "OPS", "name": "Ops"}, format="json").data
    status = statuses[0]

    r = api.patch(f"/api/statuses/{status.id}/", {"workflow": other_wf["id"]}, format="json")
    assert r.status_code == 400 and "workflow" in r.data
    assert api.patch(f"/api/statuses/{status.id}/", {"workflow": status.workflow_id, "name": "Backlog"},
                     format="json").status_code == 200  # same value plus a real edit is fine

    sprint = api.post("/api/sprints/", {"project": project["id"], "name": "S1"}, format="json").data
    r = api.patch(f"/api/sprints/{sprint['id']}/", {"project": other_project["id"]}, format="json")
    assert r.status_code == 400 and "project" in r.data

    r = api.patch(f"/api/boards/{project['board_id']}/", {"project": other_project["id"]}, format="json")
    assert r.status_code == 400 and "project" in r.data

    i1, i2 = new_issue(api, project), new_issue(api, project)
    comment = api.post("/api/comments/", {"issue": i1["id"], "body": "hi"}, format="json").data
    r = api.patch(f"/api/comments/{comment['id']}/", {"issue": i2["id"]}, format="json")
    assert r.status_code == 400 and "issue" in r.data
    assert api.patch(f"/api/comments/{comment['id']}/", {"body": "edited"}, format="json").status_code == 200


# --- 3. closed sprints ---------------------------------------------------------------------


def test_issues_cannot_join_a_closed_sprint(api, project, statuses, new_issue, move):
    sprint = api.post("/api/sprints/", {"project": project["id"], "name": "S1"}, format="json").data
    finished = new_issue(api, project, sprint=sprint["id"])
    for s in statuses[1:]:  # To Do → In Progress → In Review → Done
        move(api, finished["id"], s)
    api.post(f"/api/sprints/{sprint['id']}/start/")
    assert api.post(f"/api/sprints/{sprint['id']}/complete/").status_code == 200

    r = api.post("/api/issues/", {"project": project["id"], "title": "Late", "sprint": sprint["id"]}, format="json")
    assert r.status_code == 400 and "closed" in str(r.data["sprint"])
    other = new_issue(api, project)
    assert api.patch(f"/api/issues/{other['id']}/", {"sprint": sprint["id"]}, format="json").status_code == 400

    # A done issue keeps its closed sprint, and editing it (the form resends the sprint) still works.
    r = api.patch(f"/api/issues/{finished['id']}/", {"title": "Shipped", "sprint": sprint["id"]}, format="json")
    assert r.status_code == 200, r.data


# --- 4. priority ordering ------------------------------------------------------------------


def test_ordering_by_priority_follows_severity(api, project, new_issue):
    for p in ["critical", "low", "high", "medium"]:
        new_issue(api, project, priority=p, title=p)

    def order(param):
        r = api.get(f"/api/issues/?project={project['id']}&ordering={param}")
        return [i["priority"] for i in r.data["results"]]

    assert order("priority") == ["low", "medium", "high", "critical"]
    assert order("-priority") == ["critical", "high", "medium", "low"]
    assert order("-created_at")[0] == "medium"  # other orderings are unchanged


# --- 5. board query parameters -------------------------------------------------------------


def test_board_rejects_malformed_filters(api, project):
    url = f"/api/boards/{project['board_id']}/columns/"
    assert api.get(url, {"assignee": "abc"}).status_code == 400
    assert api.get(url, {"sprint": "next"}).status_code == 400
    for sprint in ["all", "active", "backlog", "999"]:
        assert api.get(url, {"sprint": sprint}).status_code == 200


# --- 6. moves re-read the status under a lock ----------------------------------------------


def test_move_checks_workflow_against_current_status_not_a_stale_copy(api, project, statuses, new_issue, move):
    todo, doing, review, done = statuses
    data = new_issue(api, project)
    move(api, data["id"], doing)
    move(api, data["id"], review)
    stale = Issue.objects.select_related("project__workflow", "status").get(pk=data["id"])  # In Review

    move(api, data["id"], doing)  # someone else moves it back meanwhile
    move(api, data["id"], todo)

    # From the stale copy, In Review → Done looks allowed; from the real status (To Do) it isn't.
    with pytest.raises(ValidationError):
        move_issue(stale, done)
    assert Issue.objects.get(pk=data["id"]).status == todo


def test_complete_requires_an_active_sprint(api, project):
    sprint = api.post("/api/sprints/", {"project": project["id"], "name": "S1"}, format="json").data
    assert api.post(f"/api/sprints/{sprint['id']}/complete/").status_code == 400
    api.post(f"/api/sprints/{sprint['id']}/start/")
    assert api.post(f"/api/sprints/{sprint['id']}/complete/").status_code == 200
    assert api.post(f"/api/sprints/{sprint['id']}/complete/").status_code == 400


# --- 7. a workflow keeps at least one status ----------------------------------------------


def test_last_status_of_a_workflow_cannot_be_deleted(api):
    wf = api.post("/api/workflows/", {"name": "Tiny"}, format="json").data
    s1 = api.post("/api/statuses/", {"workflow": wf["id"], "name": "Open"}, format="json").data
    s2 = api.post("/api/statuses/", {"workflow": wf["id"], "name": "Closed"}, format="json").data

    assert api.delete(f"/api/statuses/{s2['id']}/").status_code == 204
    r = api.delete(f"/api/statuses/{s1['id']}/")
    assert r.status_code == 400 and "at least one status" in str(r.data)


# --- Day 11: drops on a filtered board land next to the card the user dropped them by -----


def _column(status):
    return list(Issue.objects.filter(status=status).order_by("rank", "id").values_list("id", flat=True))


def test_move_after_a_neighbour_counts_cards_hidden_by_filters(api, project, statuses, new_issue, move):
    doing = statuses[1]
    # In Progress holds a, h1, h2, b; a filter (e.g. "assignee: me") hides h1 and h2.
    a, h1, h2, b = (new_issue(api, project) for _ in range(4))
    for issue in (a, h1, h2, b):
        move(api, issue["id"], doing)
    c = new_issue(api, project)
    # Filtered to "my issues" the board shows [a, b]; dropping c between them reports index 1, which
    # counted against the full column would put c before h1. The neighbour id puts it right after a.
    r = api.post(f"/api/issues/{c['id']}/move/", {"status": doing.id, "index": 1, "after": a["id"]}, format="json")
    assert r.status_code == 200, r.data
    assert _column(doing) == [a["id"], c["id"], h1["id"], h2["id"], b["id"]]

    # "before" is used for a drop at the top of a filtered column.
    d = new_issue(api, project)
    r = api.post(f"/api/issues/{d['id']}/move/", {"status": doing.id, "index": 0, "before": b["id"]}, format="json")
    assert r.status_code == 200, r.data
    assert _column(doing) == [a["id"], c["id"], h1["id"], h2["id"], d["id"], b["id"]]


def test_move_neighbour_outside_the_column_falls_back_to_index(api, project, statuses, new_issue, move):
    todo, doing = statuses[0], statuses[1]
    a, b, stranger = new_issue(api, project), new_issue(api, project), new_issue(api, project)
    move(api, a["id"], doing)
    move(api, b["id"], doing)
    c = new_issue(api, project)
    # `stranger` is still in To Do, so the id says nothing about In Progress: use the index.
    r = api.post(f"/api/issues/{c['id']}/move/", {"status": doing.id, "index": 1, "after": stranger["id"]}, format="json")
    assert r.status_code == 200, r.data
    assert _column(doing) == [a["id"], c["id"], b["id"]]
    assert Issue.objects.get(pk=stranger["id"]).status == todo


def test_move_rejects_after_and_before_together(api, project, statuses, new_issue):
    a, b = new_issue(api, project), new_issue(api, project)
    r = api.post(f"/api/issues/{a['id']}/move/", {"status": statuses[0].id, "after": b["id"], "before": b["id"]},
                 format="json")
    assert r.status_code == 400
