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


@pytest.fixture(params=[Role.MEMBER])
def member(add_member):
    return add_member("member@acme.test", Role.MEMBER)
