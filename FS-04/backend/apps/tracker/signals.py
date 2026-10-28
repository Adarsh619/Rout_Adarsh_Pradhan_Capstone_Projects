from django.db import transaction
from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import Attachment


@receiver(post_delete, sender=Attachment)
def delete_attachment_file(sender, instance, **kwargs):
    """Remove the stored file once the delete commits.

    Also fires for cascades (deleting an issue, project or workspace), so a deleted tenant's
    files don't linger on disk. Waiting for the commit keeps the file if the delete rolls back.
    """
    if not instance.file:
        return
    storage, name = instance.file.storage, instance.file.name
    transaction.on_commit(lambda: storage.delete(name))
