from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

User = get_user_model()


def check_password_strength(password, user):
    """Run AUTH_PASSWORD_VALIDATORS, reporting failures on the field the client sent."""
    try:
        validate_password(password, user=user)
    except DjangoValidationError as e:
        raise serializers.ValidationError(list(e.messages)) from e


class UserSerializer(serializers.ModelSerializer):
    display_name = serializers.ReadOnlyField()

    class Meta:
        model = User
        fields = ["id", "email", "full_name", "display_name"]
        read_only_fields = ["id", "email"]


class RegisterSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True)
    full_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    workspace_name = serializers.CharField(max_length=100, required=False, allow_blank=True)

    def validate_email(self, value):
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("An account with this email already exists.")
        return value.lower()

    def validate(self, attrs):
        # An unsaved user lets the similarity check compare the password with the email and name.
        candidate = User(email=attrs["email"], full_name=attrs.get("full_name", ""))
        try:
            check_password_strength(attrs["password"], candidate)
        except serializers.ValidationError as e:
            raise serializers.ValidationError({"password": e.detail}) from e
        return attrs


class PasswordChangeSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True)

    def validate_current_password(self, value):
        if not self.context["request"].user.check_password(value):
            raise serializers.ValidationError("Current password is incorrect.")
        return value

    def validate_new_password(self, value):
        check_password_strength(value, self.context["request"].user)
        return value
