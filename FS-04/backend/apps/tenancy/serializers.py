from django.contrib.auth import get_user_model
from rest_framework import serializers

from apps.accounts.serializers import UserSerializer

from .models import Membership, Role, Workspace


class WorkspaceSerializer(serializers.ModelSerializer):
    role = serializers.SerializerMethodField()
    plan = serializers.SerializerMethodField()

    class Meta:
        model = Workspace
        fields = ["id", "name", "slug", "created_at", "role", "plan"]
        read_only_fields = ["id", "slug", "created_at"]

    def get_role(self, obj):
        user = self.context["request"].user
        m = next((m for m in obj.memberships.all() if m.user_id == user.id), None)
        return m.role if m else None

    def get_plan(self, obj):
        sub = getattr(obj, "subscription", None)
        return sub.plan if sub else "free"


class MembershipSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)
    email = serializers.EmailField(write_only=True, required=False)

    class Meta:
        model = Membership
        fields = ["id", "user", "email", "role", "joined_at"]
        read_only_fields = ["id", "joined_at"]

    def validate_role(self, value):
        if value == Role.OWNER:
            raise serializers.ValidationError("Ownership cannot be assigned through this endpoint.")
        return value

    def validate(self, attrs):
        if self.instance is None:
            email = attrs.pop("email", None)
            if not email:
                raise serializers.ValidationError({"email": "Email is required."})
            user = get_user_model().objects.filter(email__iexact=email).first()
            if user is None:
                raise serializers.ValidationError({"email": "No user with this email. Ask them to sign up first."})
            ws = self.context["workspace"]
            if Membership.objects.filter(workspace=ws, user=user).exists():
                raise serializers.ValidationError({"email": "User is already a member."})
            attrs["user"] = user
        else:
            attrs.pop("email", None)
            if self.instance.role == Role.OWNER:
                raise serializers.ValidationError("The owner's role cannot be changed.")
        return attrs
