import time

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.db.models import Q
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from apps.audit.models import AuditLog
from apps.integrations.models import Notification, Report
from apps.tenancy.models import Membership, Role, Workspace
from apps.tracker.models import Board, Comment, Issue, Project, Sprint, StatusCategory

pytestmark = pytest.mark.django_db

BOARD_QUERY_BUDGET = 7


def seed(**opts):
    # pytest-django runs with DEBUG=False, which the command refuses without --force.
    call_command("seed_demo", force=True, **opts)


def test_seed_demo_creates_isolated_workspaces():
    seed(issues=8)
    assert Workspace.objects.filter(slug__in=["acme", "globex"]).count() == 2
    assert Issue.objects.filter(workspace__slug="acme").count() == 16
    seed(issues=3, reset=True)  # reset must work even with protected FKs and append-only audit entries
    assert Issue.objects.filter(workspace__slug="acme").count() == 6


def test_seed_refuses_to_run_in_production(settings):
    settings.DEBUG = False
    with pytest.raises(CommandError, match="DJANGO_DEBUG=true"):
        call_command("seed_demo", issues=1)
    assert not Workspace.objects.exists()


def test_seeded_data_follows_the_app_rules():
    seed(issues=10)
    acme = Workspace.objects.get(slug="acme")
    assert set(Membership.objects.filter(workspace=acme).values_list("role", flat=True)) == set(Role.values)

    # The seed writes rows directly, so check them against the same model rules the admin enforces.
    for model in [Project, Board, Sprint, Issue, Comment]:
        for obj in model.objects.filter(workspace=acme):
            obj.full_clean()

    viewer = Membership.objects.get(workspace=acme, role=Role.VIEWER).user
    assert not Issue.objects.filter(Q(reporter=viewer) | Q(assignee=viewer)).exists()  # viewers are read-only
    assert not Comment.objects.filter(author=viewer).exists()
    assert not Issue.objects.filter(sprint__state=Sprint.State.CLOSED).exclude(
        status__category=StatusCategory.DONE).exists()

    acme_people = set(Membership.objects.filter(workspace=acme).values_list("user", flat=True))
    acme_issues = Issue.objects.filter(workspace=acme)
    assert set(acme_issues.values_list("reporter", flat=True)) <= acme_people  # no Globex users in Acme


def test_seed_includes_a_realistic_history():
    seed(issues=10)
    acme = Workspace.objects.get(slug="acme")
    issues = Issue.objects.filter(workspace=acme)
    log = AuditLog.objects.filter(workspace=acme)

    assert log.filter(action="issue.created").count() == issues.count()
    for issue in issues.filter(status__category=StatusCategory.DONE)[:3]:  # To Do → In Progress → In Review → Done
        moves = log.filter(action="issue.moved", entity_id=str(issue.id)).order_by("id")
        assert [m.changes["status"][1] for m in moves] == ["In Progress", "In Review", "Done"]
    assert log.filter(action="comment.created").count() == Comment.objects.filter(workspace=acme).count()
    assert log.filter(action="member.added").count() == 4
    assert not log.filter(actor_email="").exists()

    assert Sprint.objects.filter(workspace=acme, state=Sprint.State.CLOSED).count() == 2  # one per project
    assert Notification.objects.filter(workspace=acme, read=False).exists()
    report = Report.objects.get(workspace=acme)
    assert report.data["open_total"] == issues.exclude(status__category=StatusCategory.DONE).count()


def test_board_query_count_does_not_grow_with_issues():
    """Performance guard: loading a board must not do N+1 queries."""
    seed(issues=60)
    c = APIClient()
    c.force_authenticate(Membership.objects.get(workspace__slug="acme", role=Role.OWNER).user)
    c.credentials(HTTP_X_WORKSPACE="acme")
    board = Board.objects.get(workspace__slug="acme", project__key="WEB")
    url = f"/api/boards/{board.id}/columns/?sprint=all"
    c.get(url)  # warm-up: the first request in a process also loads code

    def measure():
        with CaptureQueriesContext(connection) as ctx:
            start = time.perf_counter()
            r = c.get(url)
            elapsed = (time.perf_counter() - start) * 1000
        assert r.status_code == 200
        return len(ctx), sum(len(col["issues"]) for col in r.data["columns"]), elapsed

    queries_60, shown, ms = measure()
    assert shown == 60
    Issue.objects.filter(project=board.project, number__gt=20).delete()
    queries_20, shown, _ = measure()
    assert shown == 20

    print(f"\n[perf] board with 60 issues: {queries_60} queries, {ms:.1f} ms (warm)")
    assert queries_60 == queries_20 <= BOARD_QUERY_BUDGET
