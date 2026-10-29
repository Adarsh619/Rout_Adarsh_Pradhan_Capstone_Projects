"""Django settings for TaskFlow — a multi-tenant project management SaaS.

All configuration is read from environment variables (see ../.env.example).
"""
import os
from datetime import timedelta
from pathlib import Path

import dj_database_url
from celery.schedules import crontab

BASE_DIR = Path(__file__).resolve().parent.parent


def env_bool(name, default=False):
    return os.environ.get(name, str(default)).lower() in {"1", "true", "yes", "on"}


SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-insecure-secret-key-change-me")
DEBUG = env_bool("DJANGO_DEBUG", True)
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "*").split(",")
CSRF_TRUSTED_ORIGINS = [o for o in os.environ.get("CSRF_TRUSTED_ORIGINS", "").split(",") if o]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # third party
    "rest_framework",
    "rest_framework_simplejwt.token_blacklist",
    "django_filters",
    "corsheaders",
    "drf_spectacular",
    # local
    "apps.accounts",
    "apps.tenancy",
    "apps.tracker",
    "apps.audit",
    "apps.integrations",
    "apps.billing",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

# PostgreSQL in Docker/CI; SQLite fallback only for quick local hacking.
DATABASES = {
    "default": dj_database_url.config(
        default=os.environ.get("DATABASE_URL", f"sqlite:///{BASE_DIR / 'db.sqlite3'}"),
        conn_max_age=60,
    )
}

AUTH_USER_MODEL = "accounts.User"
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 8}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_URL = "/media/"
MEDIA_ROOT = Path(os.environ.get("MEDIA_ROOT", BASE_DIR / "media"))
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
MAX_ATTACHMENT_SIZE = int(os.environ.get("MAX_ATTACHMENT_SIZE", 10 * 1024 * 1024))

# How many reverse proxies sit in front of Django (nginx in Docker = 1). Decides which X-Forwarded-For entry
# is the real client IP, for the audit log and the rate limits. 0 ignores the header, since browsers can set it.
# Only correct if clients can't reach Django without going through those proxies.
TRUSTED_PROXY_COUNT = int(os.environ.get("TRUSTED_PROXY_COUNT", 0))

# --- REST framework -------------------------------------------------------
REST_FRAMEWORK = {
    "NUM_PROXIES": TRUSTED_PROXY_COUNT,  # unset, DRF would key rate limits on the raw, spoofable header
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework_simplejwt.authentication.JWTAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.LimitOffsetPagination",
    "PAGE_SIZE": 100,
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.UserRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {
        "user": os.environ.get("API_RATE_LIMIT", "2000/hour"),
        # register, login and password change; counted per IP for anonymous callers
        "auth": os.environ.get("AUTH_RATE_LIMIT", "10/minute"),
    },
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=int(os.environ.get("JWT_ACCESS_MINUTES", 60))),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    # Each refresh returns a new refresh token and blacklists the old one, so a leaked token stops working.
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
}

SPECTACULAR_SETTINGS = {
    "TITLE": "TaskFlow API",
    "DESCRIPTION": "Multi-tenant project management API. Send `X-Workspace: <slug>` on tenant-scoped endpoints.",
    "VERSION": "1.0.0",
    # Two "plan" choice lists in billing: every plan, and the ones you can buy.
    "ENUM_NAME_OVERRIDES": {
        "BillingPlanEnum": ["free", "pro", "business"],
        "PaidPlanEnum": ["pro", "business"],
    },
}

CORS_ALLOWED_ORIGINS = [
    o for o in os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",") if o
]
CORS_ALLOW_HEADERS = [
    "accept", "authorization", "content-type", "origin", "x-csrftoken", "x-requested-with", "x-workspace",
]

# --- Celery ---------------------------------------------------------------
CELERY_BROKER_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
CELERY_RESULT_BACKEND = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
CELERY_TASK_ALWAYS_EAGER = env_bool("CELERY_TASK_ALWAYS_EAGER", False)
CELERY_TASK_EAGER_PROPAGATES = True
CELERY_TIMEZONE = TIME_ZONE
CELERY_BEAT_SCHEDULE = {
    "weekly-workspace-reports": {
        "task": "apps.integrations.tasks.generate_all_weekly_reports",
        "schedule": crontab(hour=6, minute=0, day_of_week="mon"),
    },
    "daily-due-date-reminders": {
        "task": "apps.integrations.tasks.send_due_date_reminders",
        "schedule": crontab(hour=7, minute=0),
    },
    "daily-webhook-delivery-cleanup": {
        "task": "apps.integrations.tasks.delete_old_webhook_deliveries",
        "schedule": crontab(hour=3, minute=30),
    },
}

# --- Outgoing webhooks ------------------------------------------------------
# Private, loopback and internal addresses are refused (see apps/integrations/urlsafety.py).
# Turn this on only to test against a receiver running on your own machine.
WEBHOOK_ALLOW_PRIVATE_URLS = env_bool("WEBHOOK_ALLOW_PRIVATE_URLS", False)
WEBHOOK_DELIVERY_RETENTION_DAYS = int(os.environ.get("WEBHOOK_DELIVERY_RETENTION_DAYS", 30))

# --- Email (console in dev) -------------------------------------------------
EMAIL_BACKEND = os.environ.get("EMAIL_BACKEND", "django.core.mail.backends.console.EmailBackend")
DEFAULT_FROM_EMAIL = os.environ.get("DEFAULT_FROM_EMAIL", "TaskFlow <noreply@taskflow.local>")

# --- Stripe ---------------------------------------------------------------------
# Two ways to run billing:
#   STRIPE_MOCK=true  -> Stripe's official mock server (stripe-mock) + simulated checkout page.
#                        No Stripe account needed (Stripe is invite-only in some countries).
#   STRIPE_MOCK=false -> real Stripe *test mode* keys from dashboard.stripe.com.
STRIPE_MOCK = env_bool("STRIPE_MOCK", False)
STRIPE_API_BASE = os.environ.get("STRIPE_API_BASE", "http://localhost:12111")  # only used in mock mode
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "") or ("sk_test_mock" if STRIPE_MOCK else "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "") or ("whsec_mock_local" if STRIPE_MOCK else "")
STRIPE_PRICE_PRO = os.environ.get("STRIPE_PRICE_PRO", "") or ("price_mock_pro" if STRIPE_MOCK else "")
STRIPE_PRICE_BUSINESS = os.environ.get("STRIPE_PRICE_BUSINESS", "") or ("price_mock_business" if STRIPE_MOCK else "")
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173")

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": os.environ.get("LOG_LEVEL", "INFO")},
}
