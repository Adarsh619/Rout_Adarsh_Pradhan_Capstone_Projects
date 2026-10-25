from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import User


@admin.register(User)
class EmailUserAdmin(UserAdmin):
    ordering = ["email"]
    list_display = ["email", "full_name", "is_staff"]
    fieldsets = UserAdmin.fieldsets + (("Profile", {"fields": ("full_name",)}),)
