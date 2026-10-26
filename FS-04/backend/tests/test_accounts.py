import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

User = get_user_model()
STRONG = "violet-harbour-42"


def login(email, password):
    return APIClient().post("/api/auth/token/", {"email": email, "password": password}, format="json")


def test_login_ignores_email_case(owner):
    r = login("Owner@ACME.test", "pass12345")
    assert r.status_code == 200 and "access" in r.data


def test_login_wrong_password_is_rejected(owner):
    assert login(owner.email, "wrong-password").status_code == 401


@pytest.mark.parametrize("password, message", [
    ("short1", "too short"),
    ("password123", "too common"),
    ("4815162342", "entirely numeric"),
    ("jane.doe.co", "too similar"),
])
def test_register_rejects_weak_passwords(password, message):
    r = APIClient().post("/api/auth/register/", {"email": "jane.doe@co.test", "password": password}, format="json")
    assert r.status_code == 400
    assert message in " ".join(r.data["password"])
    assert not User.objects.filter(email="jane.doe@co.test").exists()


def test_register_rejects_duplicate_email_in_any_case(owner):
    r = APIClient().post("/api/auth/register/", {"email": "OWNER@acme.test", "password": STRONG}, format="json")
    assert r.status_code == 400 and "email" in r.data


def test_me_returns_and_updates_profile(owner, client_for):
    c = client_for(owner)
    assert c.get("/api/auth/me/").data["email"] == "owner@acme.test"
    r = c.patch("/api/auth/me/", {"full_name": "Olivia Owner", "email": "hijack@evil.test"}, format="json")
    assert r.status_code == 200
    owner.refresh_from_db()
    assert owner.full_name == "Olivia Owner"
    assert owner.email == "owner@acme.test"  # email is read-only


def test_refresh_rotates_and_old_token_stops_working(owner):
    c = APIClient()
    first = login(owner.email, "pass12345").data["refresh"]
    r = c.post("/api/auth/token/refresh/", {"refresh": first}, format="json")
    assert r.status_code == 200 and r.data["refresh"] != first
    assert c.post("/api/auth/token/refresh/", {"refresh": first}, format="json").status_code == 401


def test_logout_blacklists_refresh_token(owner):
    c = APIClient()
    refresh = login(owner.email, "pass12345").data["refresh"]
    assert c.post("/api/auth/logout/", {"refresh": refresh}, format="json").status_code == 200
    assert c.post("/api/auth/token/refresh/", {"refresh": refresh}, format="json").status_code == 401


def test_password_change(owner):
    old_refresh = login(owner.email, "pass12345").data["refresh"]
    c = APIClient()
    c.force_authenticate(owner)

    r = c.post("/api/auth/password/", {"current_password": "nope", "new_password": STRONG}, format="json")
    assert r.status_code == 400 and "current_password" in r.data
    r = c.post("/api/auth/password/", {"current_password": "pass12345", "new_password": "12345678"}, format="json")
    assert r.status_code == 400 and "new_password" in r.data

    r = c.post("/api/auth/password/", {"current_password": "pass12345", "new_password": STRONG}, format="json")
    assert r.status_code == 200 and r.data["access"] and r.data["refresh"]
    assert login(owner.email, "pass12345").status_code == 401
    assert login(owner.email, STRONG).status_code == 200
    # Sessions started before the change are signed out; the pair returned by the change still works.
    assert APIClient().post("/api/auth/token/refresh/", {"refresh": old_refresh}, format="json").status_code == 401
    assert APIClient().post("/api/auth/token/refresh/", {"refresh": r.data["refresh"]}, format="json").status_code == 200


def test_password_change_requires_login():
    r = APIClient().post("/api/auth/password/", {"current_password": "x", "new_password": STRONG}, format="json")
    assert r.status_code == 401


def test_login_is_rate_limited(owner, monkeypatch):
    from rest_framework.throttling import ScopedRateThrottle

    # DRF reads the rates once at import, so patch the class rather than settings.
    monkeypatch.setitem(ScopedRateThrottle.THROTTLE_RATES, "auth", "3/minute")
    codes = [login(owner.email, "wrong-password").status_code for _ in range(4)]
    assert codes == [401, 401, 401, 429]


def test_admin_add_user_form_uses_email(owner):
    from apps.accounts.admin import EmailUserCreationForm

    form = EmailUserCreationForm(data={"email": "New.Admin@Acme.test", "full_name": "New Admin",
                                       "usable_password": "true", "password1": STRONG, "password2": STRONG})
    assert form.is_valid(), form.errors
    user = form.save()
    assert user.email == "new.admin@acme.test" and user.username == user.email
    assert login("new.admin@acme.test", STRONG).status_code == 200

    dupe = EmailUserCreationForm(data={"email": "OWNER@acme.test", "usable_password": "true",
                                       "password1": STRONG, "password2": STRONG})
    assert not dupe.is_valid() and "email" in dupe.errors


def test_admin_add_user_page_renders(owner):
    from django.test import Client

    owner.is_staff = owner.is_superuser = True
    owner.save()
    c = Client()
    c.force_login(owner)
    r = c.get("/admin/accounts/user/add/")
    assert r.status_code == 200
    assert b'name="email"' in r.content and b'name="username"' not in r.content
