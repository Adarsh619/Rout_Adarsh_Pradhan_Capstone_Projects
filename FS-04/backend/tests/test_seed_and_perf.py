import time

import pytest
from django.core.management import call_command
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from apps.tenancy.models import Workspace
from apps.tracker.models import Issue

pytestmark = pytest.mark.django_db


def test_seed_demo_creates_isolated_workspaces():
    call_command("seed_demo", issues=20)
    assert Workspace.objects.filter(slug__in=["acme", "globex"]).count() == 2
    assert Issue.objects.filter(workspace__slug="acme").count() == 40
    call_command("seed_demo", issues=5, reset=True)  # reset must work even with protected FKs
    assert Issue.objects.filter(workspace__slug="acme").count() == 10


def test_board_endpoint_query_count_is_constant():
    """Performance guard: loading a board must not do N+1 queries."""
    call_command("seed_demo", issues=60)
    from django.contrib.auth import get_user_model

    c = APIClient()
    c.force_authenticate(get_user_model().objects.get(email="owner@acme.test"))
    c.credentials(HTTP_X_WORKSPACE="acme")
    board = Workspace.objects.get(slug="acme")
    from apps.tracker.models import Board

    board = Board.objects.filter(workspace=board, kind="kanban").first()
    with CaptureQueriesContext(connection) as ctx:
        start = time.perf_counter()
        r = c.get(f"/api/boards/{board.id}/columns/?sprint=all")
        elapsed = time.perf_counter() - start
    assert r.status_code == 200
    print(f"\n[perf] board with 60 issues: {len(ctx)} queries, {elapsed * 1000:.1f} ms")
    assert len(ctx) < 20
