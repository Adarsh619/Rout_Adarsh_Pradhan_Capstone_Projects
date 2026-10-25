"""Seed demo data with Faker: two isolated workspaces, users with every role, projects, sprints, issues.

    python manage.py seed_demo            # default size
    python manage.py seed_demo --issues 150 --reset
"""
import random
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone
from faker import Faker

from apps.tenancy.models import Membership, Role, Workspace
from apps.tenancy.services import create_workspace, delete_workspace
from apps.tracker.models import Board, Comment, Issue, Project, Sprint
from apps.tracker.services import default_workflow

DEMO_PASSWORD = "demo12345"


class Command(BaseCommand):
    help = "Create demo workspaces, users and issues"

    def add_arguments(self, parser):
        parser.add_argument("--issues", type=int, default=60, help="issues per project")
        parser.add_argument("--reset", action="store_true", help="delete demo workspaces first")

    @transaction.atomic
    def handle(self, *args, **opts):
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

            users = [owner]
            for role in [Role.ADMIN, Role.MEMBER, Role.MEMBER, Role.VIEWER]:
                u, _ = User.objects.get_or_create(
                    email=f"{role}{len(users)}@{slug}.test", defaults={"full_name": fake.name()}
                )
                u.set_password(DEMO_PASSWORD)
                u.save()
                Membership.objects.get_or_create(workspace=ws, user=u, defaults={"role": role})
                users.append(u)

            wf = default_workflow(ws)
            statuses = list(wf.statuses.all())
            for key, name in [("WEB", "Website Revamp"), ("API", "Public API")]:
                project = Project.objects.create(workspace=ws, key=key, name=name, workflow=wf, lead=owner,
                                                 description=fake.paragraph())
                Board.objects.create(workspace=ws, project=project, name=f"{key} board",
                                     kind=Board.Kind.SCRUM if key == "API" else Board.Kind.KANBAN)
                today = timezone.localdate()
                active = Sprint.objects.create(workspace=ws, project=project, name=f"{key} Sprint 1",
                                               goal=fake.sentence(), state=Sprint.State.ACTIVE,
                                               start_date=today - timedelta(days=5), end_date=today + timedelta(days=9))
                Sprint.objects.create(workspace=ws, project=project, name=f"{key} Sprint 2",
                                      start_date=today + timedelta(days=10), end_date=today + timedelta(days=24))
                for n in range(1, opts["issues"] + 1):
                    status = random.choices(statuses, weights=[4, 3, 1, 3])[0]
                    issue = Issue.objects.create(
                        workspace=ws, project=project, number=n,
                        title=fake.sentence(nb_words=random.randint(4, 9)).rstrip("."),
                        description=fake.paragraph(nb_sentences=3),
                        type=random.choice(Issue.Type.values), priority=random.choice(Issue.Priority.values),
                        status=status, assignee=random.choice(users + [None]), reporter=random.choice(users),
                        sprint=active if random.random() < 0.5 else None,
                        story_points=random.choice([1, 2, 3, 5, 8, None]),
                        due_date=today + timedelta(days=random.randint(-5, 30)) if random.random() < 0.4 else None,
                        rank=n * 1000,
                    )
                    for _ in range(random.randint(0, 3)):
                        Comment.objects.create(workspace=ws, issue=issue, author=random.choice(users),
                                               body=fake.sentence(nb_words=14))
                project.issue_counter = opts["issues"]
                project.save(update_fields=["issue_counter"])
            self.stdout.write(self.style.SUCCESS(f"Seeded {company} ({slug})"))

        self.stdout.write(f"Log in as owner@acme.test / {DEMO_PASSWORD} (also admin1@, member2@, viewer4@acme.test)")
