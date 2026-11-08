"""Public demo site (DEMO_MODE): locked demo logins, nightly reset, visitor clean-up, version in /health."""
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.tenancy.models import Workspace
from apps.tenancy.services import create_workspace
from apps.tracker.models import Project
from apps.tracker.tasks import purge_visitor_data, reset_demo_data

pytestmark = pytest.mark.django_db
User = get_user_model()


@pytest.fixture
def demo_mode(settings):
    settings.DEMO_MODE = True
    settings.DEBUG = False
    return settings


def _age(obj, days, field):
    type(obj).objects.filter(pk=obj.pk).update(**{field: timezone.now() - timedelta(days=days)})


# --- demo logins can't be changed on the live site ---------------------------------------------------------------


def test_demo_login_cannot_change_password_or_profile(demo_mode, owner, client_for):
    c = client_for(owner)  # owner@acme.test is a published demo login
    r = c.post("/api/auth/password/", {"current_password": "pass12345", "new_password": "Brand-new-pass-42"},
               format="json")
    assert r.status_code == 403 and "shared demo account" in r.data["detail"]
    assert c.patch("/api/auth/me/", {"full_name": "Hijacked"}, format="json").status_code == 403
    owner.refresh_from_db()
    assert owner.check_password("pass12345") and owner.full_name != "Hijacked"


def test_visitor_accounts_work_normally_in_demo_mode(demo_mode, make_user, client_for):
    visitor = make_user("visitor@example.com")
    c = client_for(visitor)
    assert c.patch("/api/auth/me/", {"full_name": "Vee"}, format="json").status_code == 200
    r = c.post("/api/auth/password/", {"current_password": "pass12345", "new_password": "Brand-new-pass-42"},
               format="json")
    assert r.status_code == 200


def test_demo_logins_are_ordinary_when_demo_mode_is_off(owner, client_for):
    r = client_for(owner).patch("/api/auth/me/", {"full_name": "Olivia"}, format="json")
    assert r.status_code == 200 and r.data["demo_mode"] is False and r.data["is_demo_account"] is False


def test_me_tells_the_app_about_the_demo(demo_mode, owner, make_user, client_for):
    me = client_for(owner).get("/api/auth/me/").data
    assert me["demo_mode"] is True and me["is_demo_account"] is True
    visitor = client_for(make_user("visitor@example.com")).get("/api/auth/me/").data
    assert visitor["demo_mode"] is True and visitor["is_demo_account"] is False


# --- nightly reset and visitor clean-up --------------------------------------------------------------------------


def test_nightly_reset_rebuilds_vandalised_demo_data(demo_mode):
    reset_demo_data(issues=2)
    acme = Workspace.objects.get(slug="acme")
    Project.objects.filter(workspace=acme).delete()  # a visitor wrecks the demo
    owner = User.objects.get(email="owner@acme.test")
    owner.set_password("changed-by-someone")
    owner.save()

    reset_demo_data(issues=2)
    acme = Workspace.objects.get(slug="acme")
    assert Project.objects.filter(workspace=acme).count() == 2
    assert User.objects.get(email="owner@acme.test").check_password("demo12345")


def test_purge_removes_old_visitor_data_only(demo_mode, make_user):
    reset_demo_data(issues=2)
    old_visitor = make_user("old@example.com")
    old_ws = create_workspace("Old Co", old_visitor)
    _age(old_ws, 8, "created_at")
    _age(old_visitor, 8, "date_joined")
    new_visitor = make_user("new@example.com")
    new_ws = create_workspace("New Co", new_visitor)
    _age(next(iter(Workspace.objects.filter(slug="acme"))), 30, "created_at")  # demo data is never purged

    assert purge_visitor_data() == "purged 1 workspaces, 1 accounts"
    assert not Workspace.objects.filter(pk=old_ws.pk).exists()
    assert not User.objects.filter(email="old@example.com").exists()
    assert Workspace.objects.filter(pk=new_ws.pk).exists() and User.objects.filter(pk=new_visitor.pk).exists()
    assert Workspace.objects.filter(slug="acme").exists() and User.objects.filter(email="owner@acme.test").exists()


def test_housekeeping_does_nothing_outside_demo_mode(make_user):
    visitor = make_user("old@example.com")
    ws = create_workspace("Old Co", visitor)
    _age(ws, 30, "created_at")
    assert reset_demo_data(issues=2).startswith("skipped")
    assert purge_visitor_data().startswith("skipped")
    assert Workspace.objects.filter(pk=ws.pk).exists() and not Workspace.objects.filter(slug="acme").exists()


def test_reset_is_scheduled_nightly(settings):
    entry = settings.CELERY_BEAT_SCHEDULE["nightly-demo-reset"]
    assert entry["task"] == "apps.tracker.tasks.reset_demo_data"
    assert entry["schedule"].hour == {21} and entry["schedule"].minute == {0}


# --- health reports the deployed version without touching the database ------------------------------------------


def test_health_reports_version_without_database(client, monkeypatch, django_assert_num_queries):
    monkeypatch.setenv("APP_VERSION", "abc1234")
    with django_assert_num_queries(0):
        r = client.get("/api/health/")
    assert r.json() == {"status": "ok", "version": "abc1234"}
