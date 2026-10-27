from django import forms
from django.contrib import admin

from .models import Membership, Role, Workspace

TRANSFER_HINT = "Ownership changes go through POST /api/workspaces/<slug>/transfer/."


class MembershipForm(forms.ModelForm):
    """Keep exactly one owner per workspace: the role can't be granted to, or taken from, anyone here."""

    class Meta:
        model = Membership
        fields = ["workspace", "user", "role"]

    def clean_role(self):
        role = self.cleaned_data["role"]
        was_owner = self.instance.pk is not None and self.instance.role == Role.OWNER
        if role == Role.OWNER and not was_owner:
            raise forms.ValidationError(f"A workspace has one owner. {TRANSFER_HINT}")
        if was_owner and role != Role.OWNER:
            raise forms.ValidationError(f"The owner's role can't be changed here. {TRANSFER_HINT}")
        return role


class MembershipFormSet(forms.BaseInlineFormSet):
    def clean(self):
        super().clean()
        for form in self.forms:
            if self.can_delete and self._should_delete_form(form) and form.instance.role == Role.OWNER:
                raise forms.ValidationError("The owner's membership can't be deleted.")


class MembershipInline(admin.TabularInline):
    model = Membership
    form = MembershipForm
    formset = MembershipFormSet
    extra = 0


@admin.register(Workspace)
class WorkspaceAdmin(admin.ModelAdmin):
    list_display = ["name", "slug", "owner", "created_at"]
    search_fields = ["name", "slug", "owner__email"]
    inlines = [MembershipInline]


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    form = MembershipForm
    list_display = ["user", "workspace", "role", "joined_at"]
    list_filter = ["role"]
    search_fields = ["user__email", "workspace__name", "workspace__slug"]

    def has_delete_permission(self, request, obj=None):
        if obj is not None and obj.role == Role.OWNER:
            return False
        return super().has_delete_permission(request, obj)
