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


def enforce_limit(workspace, resource):
    """Raise 402 if the workspace's plan has no room for one more `resource`.

    Call it inside the transaction that creates the item: it locks the workspace's subscription row, so two
    requests creating at the same moment are counted one after the other instead of both seeing room for one.
    (Outside a transaction, select_for_update raises, which keeps callers honest.)
    """
    from .models import Subscription

    sub, _ = Subscription.objects.select_for_update().get_or_create(workspace=workspace)
    plan = sub.effective_plan
    limit = PLANS[plan]["limits"][resource]
    if limit is None:
        return
    used = usage(workspace)[resource]
    if used >= limit:
        raise PlanLimitExceeded(
            f"Your {PLANS[plan]['name']} plan allows {limit} {resource}. Upgrade to add more."
        )
