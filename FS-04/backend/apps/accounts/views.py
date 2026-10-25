from django.db import transaction
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken

from apps.tenancy.services import create_workspace

from .serializers import RegisterSerializer, UserSerializer


class RegisterView(generics.GenericAPIView):
    """Create an account (and optionally a first workspace). Returns JWT tokens."""

    permission_classes = [permissions.AllowAny]
    serializer_class = RegisterSerializer

    @transaction.atomic
    def post(self, request):
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        from django.contrib.auth import get_user_model

        user = get_user_model().objects.create_user(
            email=data["email"], password=data["password"], full_name=data.get("full_name", "")
        )
        workspace = None
        if data.get("workspace_name"):
            workspace = create_workspace(name=data["workspace_name"], owner=user)
        refresh = RefreshToken.for_user(user)
        return Response(
            {
                "user": UserSerializer(user).data,
                "access": str(refresh.access_token),
                "refresh": str(refresh),
                "workspace": workspace.slug if workspace else None,
            },
            status=status.HTTP_201_CREATED,
        )


class MeView(generics.RetrieveUpdateAPIView):
    serializer_class = UserSerializer

    def get_object(self):
        return self.request.user
