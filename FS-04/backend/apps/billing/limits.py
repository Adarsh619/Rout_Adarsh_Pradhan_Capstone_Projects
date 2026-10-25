from rest_framework.exceptions import APIException

from .plans import PLANS


class PlanLimitExceeded(APIException):
    status_code = 402
    default_code = "plan_limit"


def usage(workspace):
    from apps.tenancy.models import Membership
    from apps.tracker.models import Issue, Project

    return {
        "projects": Project.objects.filter(workspace=workspace).count(),
        "members": Membership.objects.filter(workspace=workspace).count(),
        "issues": Issue.objects.filter(workspace=workspace).count(),
    }


def current_plan(workspace):
    from .models import Subscription

    sub, _ = Subscription.objects.get_or_create(workspace=workspace)
    return sub.effective_plan


def enforce_limit(workspace, resource):
    plan = current_plan(workspace)
    limit = PLANS[plan]["limits"][resource]
    if limit is None:
        return
    used = usage(workspace)[resource]
    if used >= limit:
        raise PlanLimitExceeded(
            f"Your {PLANS[plan]['name']} plan allows {limit} {resource}. Upgrade to add more."
        )
