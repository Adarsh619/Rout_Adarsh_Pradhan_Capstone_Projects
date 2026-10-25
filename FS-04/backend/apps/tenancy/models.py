"""Tenant isolation: shared database, shared schema, every tenant-owned row carries `workspace_id`.

`TenantModel` is the abstract base for all tenant-owned data. API views resolve the
current workspace from the `X-Workspace` header (see `mixins.TenantScopedMixin`) and
every queryset is filtered by it, so one company can never read another's rows.
"""
from django.conf import settings
from django.db import models


class Workspace(models.Model):
    name = models.CharField(max_length=100)
    slug = models.SlugField(max_length=60, unique=True)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="owned_workspaces")
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class Role(models.TextChoices):
    OWNER = "owner", "Owner"
    ADMIN = "admin", "Admin"
    MEMBER = "member", "Member"
    VIEWER = "viewer", "Viewer"


ROLE_RANK = {Role.VIEWER: 0, Role.MEMBER: 1, Role.ADMIN: 2, Role.OWNER: 3}


class Membership(models.Model):
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="memberships")
    role = models.CharField(max_length=10, choices=Role.choices, default=Role.MEMBER)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["workspace", "user"], name="unique_membership")]

    def __str__(self):
        return f"{self.user} @ {self.workspace} ({self.role})"

    def has_role(self, minimum):
        return ROLE_RANK[self.role] >= ROLE_RANK[minimum]


class TenantQuerySet(models.QuerySet):
    def for_workspace(self, workspace):
        return self.filter(workspace=workspace)


class TenantModel(models.Model):
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="+", db_index=True)

    objects = TenantQuerySet.as_manager()

    class Meta:
        abstract = True
