import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.tenancy.models import Membership, Role
from apps.tenancy.services import create_workspace


@pytest.fixture(autouse=True)
def _eager_celery(settings, tmp_path):
    settings.CELERY_TASK_ALWAYS_EAGER = True
    settings.MEDIA_ROOT = tmp_path
    from config.celery import app

    app.conf.task_always_eager = True
    app.conf.task_eager_propagates = True


@pytest.fixture(autouse=True)
def _reset_throttles():
    # Rate-limit counters live in the cache; start every test with a clean slate.
    from django.core.cache import cache

    cache.clear()


@pytest.fixture(autouse=True)
def _public_dns(monkeypatch):
    # Webhook deliveries resolve the receiver's host to check it's public. Tests don't use real DNS:
    # every host resolves to a public documentation address unless a test says otherwise.
    monkeypatch.setattr("apps.integrations.urlsafety.resolve", lambda host: {"93.184.215.14"})


@pytest.fixture(autouse=True)
def _fast_password_hashing(settings):
    # Real password hashing is deliberately slow (~0.3 s per user); tests only need it to work.
    settings.PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]


@pytest.fixture
def make_user(db):
    def _make(email, password="pass12345"):
        return get_user_model().objects.create_user(email=email, password=password, full_name=email.split("@")[0])

    return _make


@pytest.fixture
def owner(make_user):
    return make_user("owner@acme.test")


@pytest.fixture
def workspace(owner):
    return create_workspace("Acme", owner)


@pytest.fixture
def add_member(workspace, make_user):
    def _add(email, role):
        user = make_user(email)
        Membership.objects.create(workspace=workspace, user=user, role=role)
        return user

    return _add


@pytest.fixture
def client_for():
    def _client(user, workspace=None):
        c = APIClient()
        c.force_authenticate(user)
        if workspace is not None:
            c.credentials(HTTP_X_WORKSPACE=workspace.slug)
        return c

    return _client


@pytest.fixture
def api(owner, workspace, client_for):
    return client_for(owner, workspace)


@pytest.fixture
def project(api):
    r = api.post("/api/projects/", {"key": "web", "name": "Website"}, format="json")
    assert r.status_code == 201, r.data
    return r.data


@pytest.fixture
def statuses(workspace):
    from apps.tracker.models import WorkflowStatus

    return list(WorkflowStatus.objects.filter(workspace=workspace).order_by("order"))


@pytest.fixture
def member(add_member):
    return add_member("member@acme.test", Role.MEMBER)


# --- API helpers shared by the test files: each returns the response data and fails loudly on errors ----


@pytest.fixture
def new_issue():
    def _new(client, project, **fields):
        r = client.post("/api/issues/", {"project": project["id"], "title": "Task", **fields}, format="json")
        assert r.status_code == 201, r.data
        return r.data

    return _new


@pytest.fixture
def move():
    def _move(client, issue_id, status, index=None):
        body = {"status": status.id} if index is None else {"status": status.id, "index": index}
        r = client.post(f"/api/issues/{issue_id}/move/", body, format="json")
        assert r.status_code == 200, r.data
        return r.data

    return _move


@pytest.fixture
def new_sprint():
    def _new(client, project, **fields):
        r = client.post("/api/sprints/", {"project": project["id"], "name": "Sprint", **fields}, format="json")
        assert r.status_code == 201, r.data
        return r.data

    return _new
