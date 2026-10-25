from django.contrib import admin
from django.http import JsonResponse
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from apps.accounts.views import MeView, RegisterView
from apps.audit.views import AuditLogViewSet
from apps.billing.views import BillingView, CheckoutView, PortalView, StripeWebhookView
from apps.integrations.views import NotificationViewSet, ReportViewSet, WebhookViewSet
from apps.tenancy.views import MembershipViewSet, WorkspaceViewSet
from apps.tracker import views as t

router = DefaultRouter()
router.register("workspaces", WorkspaceViewSet, basename="workspace")
router.register("members", MembershipViewSet, basename="member")
router.register("workflows", t.WorkflowViewSet, basename="workflow")
router.register("statuses", t.WorkflowStatusViewSet, basename="status")
router.register("transitions", t.WorkflowTransitionViewSet, basename="transition")
router.register("projects", t.ProjectViewSet, basename="project")
router.register("boards", t.BoardViewSet, basename="board")
router.register("sprints", t.SprintViewSet, basename="sprint")
router.register("issues", t.IssueViewSet, basename="issue")
router.register("comments", t.CommentViewSet, basename="comment")
router.register("attachments", t.AttachmentViewSet, basename="attachment")
router.register("audit-logs", AuditLogViewSet, basename="auditlog")
router.register("webhooks", WebhookViewSet, basename="webhook")
router.register("notifications", NotificationViewSet, basename="notification")
router.register("reports", ReportViewSet, basename="report")


def health(_request):
    return JsonResponse({"status": "ok"})


urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health/", health),
    path("api/auth/register/", RegisterView.as_view()),
    path("api/auth/token/", TokenObtainPairView.as_view()),
    path("api/auth/token/refresh/", TokenRefreshView.as_view()),
    path("api/auth/me/", MeView.as_view()),
    path("api/billing/", BillingView.as_view()),
    path("api/billing/checkout/", CheckoutView.as_view()),
    path("api/billing/portal/", PortalView.as_view()),
    path("api/billing/stripe-webhook/", StripeWebhookView.as_view()),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema")),
    path("api/", include(router.urls)),
]
