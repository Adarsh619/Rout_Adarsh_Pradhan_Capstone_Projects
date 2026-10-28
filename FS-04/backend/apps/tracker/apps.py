from django.apps import AppConfig


class TrackerConfig(AppConfig):
    name = "apps.tracker"

    def ready(self):
        from . import signals  # noqa: F401  (registers the attachment-file cleanup)
