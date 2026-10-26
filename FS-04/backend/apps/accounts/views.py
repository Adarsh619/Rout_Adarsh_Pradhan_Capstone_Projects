from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from rest_framework import generics, permissions, serializers, status
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenBlacklistView, TokenObtainPairView

from apps.tenancy.services import create_workspace

from .serializers import PasswordChangeSerializer, RegisterSerializer, UserSerializer


class AuthThrottleMixin:
    """Endpoints that take a password get a tight per-IP (or per-user) limit: AUTH_RATE_LIMIT."""

    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"


def token_pair(user):
    refresh = RefreshToken.for_user(user)
    return {"access": str(refresh.access_token), "refresh": str(refresh)}


class RegisterView(AuthThrottleMixin, generics.GenericAPIView):
    """Create an account (and optionally a first workspace). Returns JWT tokens."""

    permission_classes = [permissions.AllowAny]
    serializer_class = RegisterSerializer

    @transaction.atomic
    def post(self, request):
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        try:
            # Savepoint: two sign-ups with the same email can both pass validation; the second hits the unique index.
            with transaction.atomic():
                user = get_user_model().objects.create_user(
                    email=data["email"], password=data["password"], full_name=data.get("full_name", "")
                )
        except IntegrityError as e:
            raise serializers.ValidationError({"email": ["An account with this email already exists."]}) from e
        workspace = None
        if data.get("workspace_name"):
            workspace = create_workspace(name=data["workspace_name"], owner=user)
        return Response(
            {
                "user": UserSerializer(user).data,
                **token_pair(user),
                "workspace": workspace.slug if workspace else None,
            },
            status=status.HTTP_201_CREATED,
        )


class LoginView(AuthThrottleMixin, TokenObtainPairView):
    """Email + password → access and refresh tokens."""


class LogoutView(TokenBlacklistView):
    """Blacklist the given refresh token so it can't be used again."""


class MeView(generics.RetrieveUpdateAPIView):
    serializer_class = UserSerializer

    def get_object(self):
        return self.request.user


class PasswordChangeView(AuthThrottleMixin, generics.GenericAPIView):
    """Change your password. Every refresh token you hold is revoked; a fresh pair is returned for this session."""

    serializer_class = PasswordChangeSerializer

    @transaction.atomic
    def post(self, request):
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        user = request.user
        user.set_password(ser.validated_data["new_password"])
        user.save(update_fields=["password"])
        for token in OutstandingToken.objects.filter(user=user):
            BlacklistedToken.objects.get_or_create(token=token)
        return Response(token_pair(user))
