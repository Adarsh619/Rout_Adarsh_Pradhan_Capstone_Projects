"""Seed demo data with Faker: two isolated workspaces, users with every role, projects, sprints, issues,
plus the history a real team would have: an audit trail, notifications, a closed sprint and a weekly report.

    python manage.py seed_demo            # default size
    python manage.py seed_demo --issues 150 --reset

The demo accounts share a published password, so the command refuses to run with DJANGO_DEBUG=false
unless --force is given.
"""
import random
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from faker import Faker

from apps.audit.models import AuditLog
from apps.integrations.models import Notification, Report
from apps.integrations.notify import MESSAGES
from apps.integrations.tasks import build_weekly_report
from apps.tenancy.models import Membership, Role, Workspace
from apps.tenancy.services import create_workspace, delete_workspace
from apps.tracker.models import Board, Comment, Issue, Project, Sprint, StatusCategory
from apps.tracker.services import default_workflow

DEMO_PASSWORD = "demo12345"


class AuditTrail:
    """Collects audit entries in the order things happened and saves them in one query.

    Seeded rows are written directly rather than through the API, so the history is recorded here
    the way `audit.services.record()` would have recorded it (without IP addresses or webhooks).
    """

    def __init__(self, workspace):
        self.workspace = workspace
        self.entries = []

    def add(self, actor, action, obj, changes=None):
        self.entries.append(AuditLog(
            workspace=self.workspace, actor=actor, actor_email=actor.email, action=action,
            entity_type=obj._meta.model_name, entity_id=str(obj.pk), entity_label=str(obj)[:255],
            changes=changes or {},
        ))

    def save(self):
        AuditLog.objects.bulk_create(self.entries)


class Command(BaseCommand):
    help = "Create demo workspaces, users, issues and their history"

    def add_arguments(self, parser):
        parser.add_argument("--issues", type=int, default=60, help="issues per project")
        parser.add_argument("--reset", action="store_true", help="delete demo workspaces first")
        parser.add_argument("--force", action="store_true", help="run even with DJANGO_DEBUG=false")

    @transaction.atomic
    def handle(self, *args, **opts):
        if not settings.DEBUG and not opts["force"]:
            raise CommandError(
                f"seed_demo creates accounts with the public password '{DEMO_PASSWORD}', so it only runs with "
                "DJANGO_DEBUG=true. Pass --force to run it anyway."
            )
        fake = Faker()
        Faker.seed(42)
        random.seed(42)
        User = get_user_model()
        if opts["reset"]:
            for ws in Workspace.objects.filter(slug__in=["acme", "globex"]):
                delete_workspace(ws)

        for slug, company in [("acme", "Acme Corp"), ("globex", "Globex Inc")]:
            if Workspace.objects.filter(slug=slug).exists():
                self.stdout.write(f"Workspace {slug} exists, skipping (use --reset)")
                continue
            owner, _ = User.objects.get_or_create(email=f"owner@{slug}.test", defaults={"full_name": fake.name()})
            owner.set_password(DEMO_PASSWORD)
            owner.save()
            ws = create_workspace(company, owner)
            ws.slug = slug
            ws.save(update_fields=["slug"])
            trail = AuditTrail(ws)

            users = [owner]
            for role in [Role.ADMIN, Role.MEMBER, Role.MEMBER, Role.VIEWER]:
                u, _ = User.objects.get_or_create(
                    email=f"{role}{len(users)}@{slug}.test", defaults={"full_name": fake.name()}
                )
                u.set_password(DEMO_PASSWORD)
                u.save()
                m, _ = Membership.objects.get_or_create(workspace=ws, user=u, defaults={"role": role})
                trail.add(owner, "member.added", m, {"email": u.email, "role": role})
                users.append(u)
            # Viewers are read-only, so only these people report, comment on or work on issues.
            workers = users[:4]

            wf = default_workflow(ws)
            statuses = list(wf.statuses.all())  # To Do, In Progress, In Review, Done
            issues = []
            for key, name in [("WEB", "Website Revamp"), ("API", "Public API")]:
                issues += self._project(ws, trail, fake, key, name, owner, workers, wf, statuses, opts["issues"])
            trail.save()
            self._notifications(ws, workers, issues)
            Report.objects.create(workspace=ws, kind="weekly_summary", data=build_weekly_report(ws))
            self.stdout.write(self.style.SUCCESS(f"Seeded {company} ({slug}): {len(issues)} issues, "
                                                 f"{len(trail.entries)} audit entries"))

        self.stdout.write(f"Log in as owner@acme.test / {DEMO_PASSWORD} (also admin1@, member2@, viewer4@acme.test)")

    def _project(self, ws, trail, fake, key, name, owner, workers, wf, statuses, count):
        project = Project.objects.create(workspace=ws, key=key, name=name, workflow=wf, lead=owner,
                                         description=fake.paragraph())
        Board.objects.create(workspace=ws, project=project, name=f"{key} board",
                             kind=Board.Kind.SCRUM if key == "API" else Board.Kind.KANBAN)
        trail.add(owner, "project.created", project)

        today = timezone.localdate()
        closed = Sprint.objects.create(workspace=ws, project=project, name=f"{key} Sprint 0", goal=fake.sentence(),
                                       state=Sprint.State.CLOSED,
                                       start_date=today - timedelta(days=24), end_date=today - timedelta(days=10))
        active = Sprint.objects.create(workspace=ws, project=project, name=f"{key} Sprint 1", goal=fake.sentence(),
                                       state=Sprint.State.ACTIVE,
                                       start_date=today - timedelta(days=5), end_date=today + timedelta(days=9))
        planned = Sprint.objects.create(workspace=ws, project=project, name=f"{key} Sprint 2",
                                        start_date=today + timedelta(days=10), end_date=today + timedelta(days=24))
        for sprint in (closed, active, planned):
            trail.add(owner, "sprint.created", sprint)
        for sprint in (closed, active):
            trail.add(owner, "sprint.started", sprint)

        issues = []
        for n in range(1, count + 1):
            status = random.choices(statuses, weights=[4, 3, 1, 3])[0]
            done = status.category == StatusCategory.DONE
            # Finished work is split between the closed sprint and the current one; open work never sits in a closed sprint.
            sprint = closed if done and random.random() < 0.5 else (active if random.random() < 0.5 else None)
            reporter = random.choice(workers)
            issue = Issue.objects.create(
                workspace=ws, project=project, number=n,
                title=fake.sentence(nb_words=random.randint(4, 9)).rstrip("."),
                description=fake.paragraph(nb_sentences=3),
                type=random.choice(Issue.Type.values), priority=random.choice(Issue.Priority.values),
                status=status, assignee=random.choice(workers + [None]), reporter=reporter, sprint=sprint,
                story_points=random.choice([1, 2, 3, 5, 8, None]),
                due_date=today + timedelta(days=random.randint(-5, 30)) if random.random() < 0.4 else None,
                rank=n * 1000,
            )
            issues.append(issue)
            trail.add(reporter, "issue.created", issue, {"title": issue.title})
            # Walk the card through the default workflow to where it is now, one move at a time.
            for before, after in zip(statuses, statuses[1:statuses.index(status) + 1], strict=False):
                trail.add(issue.assignee or reporter, "issue.moved", issue, {"status": [before.name, after.name]})
            for _ in range(random.randint(0, 3)):
                author = random.choice(workers)
                comment = Comment.objects.create(workspace=ws, issue=issue, author=author,
                                                 body=fake.sentence(nb_words=14))
                trail.add(author, "comment.created", comment, {"issue": issue.key})

        returned = sum(1 for i in issues if i.sprint_id == closed.id and i.status.category != StatusCategory.DONE)
        trail.add(owner, "sprint.completed", closed, {"returned_to_backlog": returned})
        project.issue_counter = count
        project.save(update_fields=["issue_counter"])
        return issues

    def _notifications(self, ws, workers, issues):
        """A few bell notifications per person about their own issues; the newest two are unread."""
        notes = []
        for user in workers:
            others = [w for w in workers if w != user]
            for k, issue in enumerate([i for i in issues if i.assignee_id == user.id][:4]):
                actor, verb = random.choice(others), ("assigned", "commented", "moved", "assigned")[k]
                message = MESSAGES[verb].format(actor=actor.display_name, key=issue.key, title=issue.title[:120],
                                                status=issue.status.name, due=issue.due_date)
                notes.append(Notification(workspace=ws, user=user, actor=actor, verb=verb, issue=issue,
                                          message=message[:255], read=k >= 2))
        Notification.objects.bulk_create(notes)
