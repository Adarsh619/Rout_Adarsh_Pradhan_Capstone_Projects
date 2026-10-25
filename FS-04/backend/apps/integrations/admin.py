from django.contrib import admin

from .models import Notification, Report, Webhook, WebhookDelivery

for m in [Webhook, WebhookDelivery, Notification, Report]:
    admin.site.register(m)
