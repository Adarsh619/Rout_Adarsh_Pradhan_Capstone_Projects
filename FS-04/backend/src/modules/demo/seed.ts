import { faker } from "@faker-js/faker";
import type { IssueType, Priority, Role, Sprint, User, WorkflowStatus } from "../../generated/prisma/client.js";
import { config } from "../../config.js";
import { prisma } from "../../lib/db.js";
import { addDays, today } from "../../lib/http.js";
import { entity, type Entity } from "../audit/entities.js";
import { DEMO_PASSWORD, DEMO_WORKSPACES } from "../auth/demo.js";
import { hashPassword } from "../auth/passwords.js";
import { buildWeeklyReport } from "../integrations/jobs.js";
import { message, type Verb } from "../integrations/notify.js";
import { createWorkspace, deleteWorkspace } from "../tenancy/services.js";
import { defaultWorkflow, statusOrder } from "../tracker/services.js";

// Demo data generated with Faker: two isolated companies, users with every role, projects, sprints and issues, plus
// the history a real team would have (an audit trail, notifications, a closed sprint and a weekly report).
// The demo accounts share a published password, so seeding refuses to run with DEBUG off unless forced.

export class SeedRefused extends Error {}

interface Options {
  issues?: number;
  reset?: boolean;
  force?: boolean;
  log?: (line: string) => void;
}

// Seeded rows are written directly rather than through the API, so the history is recorded here the way the
// audit service would have (without IP addresses or webhooks), and saved in one query.
class AuditTrail {
  entries: Array<{ actorId: number; actorEmail: string; action: string; entity: Entity; changes: object }> = [];
  constructor(private workspaceId: number) {}
  add(actor: User, action: string, target: Entity, changes: object = {}) {
    this.entries.push({ actorId: actor.id, actorEmail: actor.email, action, entity: target, changes });
  }
  async save() {
    const base = Date.now() - this.entries.length;
    await prisma.auditLog.createMany({
      data: this.entries.map((e, i) => ({
        workspaceId: this.workspaceId, actorId: e.actorId, actorEmail: e.actorEmail, action: e.action,
        entityType: e.entity.type, entityId: String(e.entity.id), entityLabel: e.entity.label, changes: e.changes,
        createdAt: new Date(base + i), // keeps the order things happened in
      })),
    });
  }
}

const TYPES: IssueType[] = ["task", "bug", "story", "epic"];
const PRIORITIES: Priority[] = ["low", "medium", "high", "critical"];
// English text (Faker's lorem is Latin): issue titles from real words, longer text from its phrase generators.
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ACTIONS = ["Fix", "Add", "Improve", "Refactor", "Remove", "Update", "Investigate", "Document", "Test", "Speed up"];
const WHERE = ["", "", "on the dashboard", "for mobile", "in settings", "for admins", "after login", "in the API", "on the board"];
// e.g. "Fix mobile protocol on the dashboard"; `words` only varies how often a location is added.
const title = (words: number) =>
  [faker.helpers.arrayElement(ACTIONS), faker.hacker.adjective(), faker.hacker.noun(), words > 6 ? faker.helpers.arrayElement(WHERE) : ""]
    .filter(Boolean)
    .join(" ");
const paragraph = (sentences: number) => Array.from({ length: sentences }, () => `${capitalise(faker.hacker.phrase())}`).join(" ");

async function demoUser(email: string): Promise<User> {
  const password = await hashPassword(DEMO_PASSWORD);
  return prisma.user.upsert({
    where: { email },
    update: { password },
    create: { email, password, fullName: faker.person.fullName() },
  });
}

export async function seedDemo({ issues = 60, reset = false, force = false, log = () => undefined }: Options = {}) {
  if (!config.debug && !force) {
    throw new SeedRefused(
      `The demo seed creates accounts with the public password '${DEMO_PASSWORD}', so it only runs with DEBUG=true. ` +
        "Pass --force to run it anyway.",
    );
  }
  faker.seed(42);
  if (reset) {
    for (const w of await prisma.workspace.findMany({ where: { slug: { in: [...DEMO_WORKSPACES] } } })) {
      await deleteWorkspace(w.id);
    }
  }
  for (const [slug, company] of [["acme", "Acme Corp"], ["globex", "Globex Inc"]] as const) {
    if (await prisma.workspace.findUnique({ where: { slug } })) {
      log(`Workspace ${slug} exists, skipping (use --reset)`);
      continue;
    }
    const owner = await demoUser(`owner@${slug}.test`);
    const ws = await createWorkspace(company, owner, slug);
    const trail = new AuditTrail(ws.id);

    const users = [owner];
    for (const role of ["admin", "member", "member", "viewer"] as Role[]) {
      const u = await demoUser(`${role}${users.length}@${slug}.test`);
      const m = await prisma.membership.upsert({
        where: { workspaceId_userId: { workspaceId: ws.id, userId: u.id } },
        update: {},
        create: { workspaceId: ws.id, userId: u.id, role },
      });
      trail.add(owner, "member.added", entity.membership(m, u.email, ws.name), { email: u.email, role });
      users.push(u);
    }
    // Viewers are read-only, so only these people report, comment on or work on issues.
    const workers = users.slice(0, 4);
    const wf = await defaultWorkflow(prisma, ws.id);
    const statuses = await prisma.workflowStatus.findMany({ where: { workflowId: wf.id }, orderBy: statusOrder });
    const all = [];
    for (const [key, name] of [["WEB", "Website Revamp"], ["API", "Public API"]] as const) {
      all.push(...(await seedProject(ws.id, trail, key, name, owner, workers, wf.id, statuses, issues)));
    }
    await trail.save();
    await seedNotifications(ws.id, workers, all);
    await prisma.report.create({ data: { workspaceId: ws.id, kind: "weekly_summary", data: await buildWeeklyReport(ws.id) } });
    log(`Seeded ${company} (${slug}): ${all.length} issues, ${trail.entries.length} audit entries`);
  }
  log(`Log in as owner@acme.test / ${DEMO_PASSWORD} (also admin1@, member2@, viewer4@acme.test)`);
}

async function seedProject(
  workspaceId: number, trail: AuditTrail, key: string, name: string, owner: User, workers: User[],
  workflowId: number, statuses: WorkflowStatus[], count: number,
) {
  const project = await prisma.project.create({
    data: { workspaceId, key, name, workflowId, leadId: owner.id, description: paragraph(2) },
  });
  await prisma.board.create({ data: { workspaceId, projectId: project.id, name: `${key} board`, kind: key === "API" ? "scrum" : "kanban" } });
  trail.add(owner, "project.created", entity.project(project));

  const day0 = today();
  const sprint = (n: number, state: Sprint["state"], from: number, to: number, goal: string) =>
    prisma.sprint.create({
      data: { workspaceId, projectId: project.id, name: `${key} Sprint ${n}`, goal, state, startDate: addDays(day0, from), endDate: addDays(day0, to) },
    });
  const closed = await sprint(0, "closed", -24, -10, capitalise(faker.company.buzzPhrase()));
  const active = await sprint(1, "active", -5, 9, capitalise(faker.company.buzzPhrase()));
  const planned = await sprint(2, "planned", 10, 24, "");
  for (const s of [closed, active, planned]) trail.add(owner, "sprint.created", entity.sprint(s));
  for (const s of [closed, active]) trail.add(owner, "sprint.started", entity.sprint(s));

  const issues = [];
  for (let n = 1; n <= count; n++) {
    const status = faker.helpers.weightedArrayElement(statuses.map((s, i) => ({ value: s, weight: [4, 3, 1, 3][i] ?? 1 })));
    const done = status.category === "done";
    // Finished work is split between the closed sprint and the current one; open work never sits in a closed sprint.
    const sprintId = done && faker.number.float() < 0.5 ? closed.id : faker.number.float() < 0.5 ? active.id : null;
    const reporter = faker.helpers.arrayElement(workers);
    const assignee = faker.helpers.arrayElement([...workers, null]);
    const issue = await prisma.issue.create({
      data: {
        workspaceId, projectId: project.id, number: n, title: title(faker.number.int({ min: 4, max: 9 })),
        description: paragraph(3), type: faker.helpers.arrayElement(TYPES), priority: faker.helpers.arrayElement(PRIORITIES),
        statusId: status.id, assigneeId: assignee?.id ?? null, reporterId: reporter.id, sprintId,
        storyPoints: faker.helpers.arrayElement([1, 2, 3, 5, 8, null]),
        dueDate: faker.number.float() < 0.4 ? addDays(day0, faker.number.int({ min: -5, max: 30 })) : null,
        rank: n * 1000,
      },
      include: { project: { select: { key: true } }, status: true },
    });
    issues.push(issue);
    trail.add(reporter, "issue.created", entity.issue(issue, key), { title: issue.title });
    // Walk the card through the default workflow to where it is now, one move at a time.
    const at = statuses.findIndex((s) => s.id === status.id);
    for (let i = 0; i < at; i++) {
      trail.add(assignee ?? reporter, "issue.moved", entity.issue(issue, key), { status: [statuses[i]!.name, statuses[i + 1]!.name] });
    }
    for (let c = faker.number.int({ min: 0, max: 3 }); c > 0; c--) {
      const author = faker.helpers.arrayElement(workers);
      const comment = await prisma.comment.create({
        data: { workspaceId, issueId: issue.id, authorId: author.id, body: capitalise(faker.hacker.phrase()) },
      });
      trail.add(author, "comment.created", entity.comment(comment), { issue: `${key}-${n}` });
    }
  }
  const returned = issues.filter((i) => i.sprintId === closed.id && i.status.category !== "done").length;
  trail.add(owner, "sprint.completed", entity.sprint(closed), { returned_to_backlog: returned });
  await prisma.project.update({ where: { id: project.id }, data: { issueCounter: count } });
  return issues;
}

// A few bell notifications per person about their own issues; the newest two are unread.
async function seedNotifications(
  workspaceId: number, workers: User[],
  issues: Array<Parameters<typeof message>[1] & { assigneeId: number | null }>,
) {
  const verbs: Verb[] = ["assigned", "commented", "moved", "assigned"];
  const data = [];
  for (const user of workers) {
    const others = workers.filter((w) => w.id !== user.id);
    const mine = issues.filter((i) => i.assigneeId === user.id).slice(0, 4);
    for (const [k, issue] of mine.entries()) {
      const actor = faker.helpers.arrayElement(others);
      const verb = verbs[k]!;
      data.push({ workspaceId, userId: user.id, actorId: actor.id, verb, issueId: issue.id, message: message(verb, issue, actor), read: k >= 2 });
    }
  }
  await prisma.notification.createMany({ data });
}
