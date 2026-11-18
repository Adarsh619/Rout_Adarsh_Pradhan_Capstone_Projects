import supertest from "supertest";
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import type { Role, User, Workspace } from "../src/generated/prisma/client.js";
import { prisma } from "../src/lib/db.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { tokenPair } from "../src/modules/auth/tokens.js";
import { createWorkspace } from "../src/modules/tenancy/services.js";

// Shared test helpers (the v1 pytest fixtures): users, workspaces, signed-in clients and API shortcuts.

export const STRONG = "violet-harbour-42";

// A fresh app per client, so tests that change settings (rate limits, proxies) get them applied.
export const app = () => createApp();

export async function makeUser(email: string, password = "pass12345"): Promise<User> {
  return prisma.user.create({ data: { email, password: await hashPassword(password), fullName: email.split("@")[0]! } });
}

export async function addMember(workspace: Workspace, email: string, role: Role): Promise<User> {
  const user = await makeUser(email);
  await prisma.membership.create({ data: { workspaceId: workspace.id, userId: user.id, role } });
  return user;
}

type Body = string | object | undefined;
export interface Client {
  get(url: string): supertest.Test;
  post(url: string, body?: Body): supertest.Test;
  patch(url: string, body?: Body): supertest.Test;
  put(url: string, body?: Body): supertest.Test;
  delete(url: string): supertest.Test;
  // The same user, sending another X-Workspace (or none).
  workspace(slug: string | null): Client;
  token: string;
}

// A client signed in as `user`, sending X-Workspace for `workspace` (the v1 client_for fixture).
export async function clientFor(user: User | null, workspace?: Workspace | string | null): Promise<Client> {
  const token = user ? (await tokenPair(user.id)).access : "";
  const make = (slug: string | null): Client => {
    const server = app();
    const prep = (t: supertest.Test) => {
      if (token) t.set("Authorization", `Bearer ${token}`);
      if (slug) t.set("X-Workspace", slug);
      return t;
    };
    const send = (t: supertest.Test, body: Body) => (body === undefined ? t : t.send(body as object));
    return {
      token,
      get: (url) => prep(supertest(server).get(url)),
      post: (url, body) => send(prep(supertest(server).post(url)), body),
      patch: (url, body) => send(prep(supertest(server).patch(url)), body),
      put: (url, body) => send(prep(supertest(server).put(url)), body),
      delete: (url) => prep(supertest(server).delete(url)),
      workspace: (s) => make(s),
    };
  };
  const slug = typeof workspace === "string" ? workspace : (workspace?.slug ?? null);
  return make(slug);
}

export const anon = () => clientFor(null);

export interface World {
  owner: User;
  workspace: Workspace;
  api: Client;
}

// The usual starting point: owner@acme.test owns workspace "Acme" (slug acme), with a signed-in client.
export async function world(): Promise<World> {
  const owner = await makeUser("owner@acme.test");
  const workspace = await createWorkspace("Acme", owner);
  return { owner, workspace, api: await clientFor(owner, workspace) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export async function newProject(api: Client, fields: object = {}): Promise<Json> {
  const r = await api.post("/api/projects/", { key: "web", name: "Website", ...fields });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

export async function newIssue(api: Client, project: Json, fields: object = {}): Promise<Json> {
  const r = await api.post("/api/issues/", { project: project.id, title: "Task", ...fields });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

export async function newSprint(api: Client, project: Json, fields: object = {}): Promise<Json> {
  const r = await api.post("/api/sprints/", { project: project.id, name: "Sprint", ...fields });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

export async function move(api: Client, issueId: number, status: { id: number }, index?: number): Promise<Json> {
  const r = await api.post(`/api/issues/${issueId}/move/`, index === undefined ? { status: status.id } : { status: status.id, index });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

// The workspace's statuses in board order (To Do, In Progress, In Review, Done).
export const statusesOf = (workspace: Workspace) =>
  prisma.workflowStatus.findMany({ where: { workspaceId: workspace.id }, orderBy: [{ order: "asc" }, { id: "asc" }] });

export { createWorkspace, prisma };
