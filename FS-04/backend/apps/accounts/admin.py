from django import forms
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin
from django.contrib.auth.forms import AdminUserCreationForm

from .models import User


class EmailUserCreationForm(AdminUserCreationForm):
    """Django's default add form asks for a username; ours logs in by email."""

    class Meta(AdminUserCreationForm.Meta):
        model = User
        fields = ("email", "full_name")

    def clean_email(self):
        email = self.cleaned_data["email"].lower()
        if User.objects.filter(email__iexact=email).exists():
            raise forms.ValidationError("A user with this email already exists.")
        return email


@admin.register(User)
class EmailUserAdmin(UserAdmin):
    add_form = EmailUserCreationForm
    ordering = ["email"]
    list_display = ["email", "full_name", "is_staff"]
    search_fields = ["email", "full_name"]
    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Profile", {"fields": ("full_name",)}),
        ("Permissions", {"fields": ("is_active", "is_staff", "is_superuser", "groups", "user_permissions")}),
        ("Important dates", {"fields": ("last_login", "date_joined")}),
    )
    add_fieldsets = (
        (None, {
            "classes": ("wide",),
            "fields": ("email", "full_name", "usable_password", "password1", "password2"),
        }),
    )
