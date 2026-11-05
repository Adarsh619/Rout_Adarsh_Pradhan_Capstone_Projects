import type { Express } from "express";
import type { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectMongo } from "../../src/lib/mongo.js";
import { Vendor } from "../../src/modules/vendors/vendor.model.js";
import { User } from "../../src/modules/users/user.model.js";
import { bearer, register, signInAdmin, startTestServices, storeApplication, wipe } from "./helpers.js";

let app: Express;
let redis: Redis;

beforeAll(async () => {
  ({ app, redis } = await startTestServices());
  await Promise.all([User.init(), Vendor.init()]);
});

beforeEach(async () => {
  await wipe(redis);
});

afterAll(async () => {
  await wipe(redis);
  await Promise.allSettled([disconnectMongo(), redis.quit()]);
});

const api = () => request(app);
const newVendor = async (email = "vendor@example.com") => (await register(app, { email, role: "vendor" })).accessToken;
const apply = (token: string, overrides = {}) => api().post("/api/v1/vendors/apply").set(bearer(token)).send(storeApplication(overrides));
const act = (admin: string, id: string, action: string, body?: object) =>
  api().post(`/api/v1/admin/vendors/${id}/${action}`).set(bearer(admin)).send(body ?? {});

describe("store application", () => {
  it("creates a pending store with a URL slug and a normalised phone number", async () => {
    const token = await newVendor();
    const res = await apply(token, { storeName: "Vikram's Electronics & More", gstin: "29abcde1234f1z5" });
    expect(res.status).toBe(201);
    expect(res.body.store).toMatchObject({
      storeName: "Vikram's Electronics & More",
      slug: "vikrams-electronics-more",
      status: "pending",
      phone: "9876543210",
      gstin: "29ABCDE1234F1Z5",
      rejectionReason: null,
    });

    const me = await api().get("/api/v1/vendors/me").set(bearer(token));
    expect(me.body.store.status).toBe("pending");
  });

  it("explains invalid fields one message each", async () => {
    const token = await newVendor();
    const res = await apply(token, { storeName: "ab", phone: "12345", gstin: "NOTAGSTIN", contactEmail: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.map((f: { field: string }) => f.field).sort()).toEqual([
      "contactEmail",
      "gstin",
      "phone",
      "storeName",
    ]);
  });

  it("gives two stores with the same name different slugs", async () => {
    await apply(await newVendor("a@example.com"), { storeName: "Same Name" });
    const second = await apply(await newVendor("b@example.com"), { storeName: "Same Name" });
    expect(second.body.store.slug).toBe("same-name-2");
  });

  it("is only for vendor accounts", async () => {
    const { accessToken } = await register(app, { email: "c@example.com" });
    const res = await apply(accessToken);
    expect(res.status).toBe(403);
    expect(res.body.error.details.requiredRoles).toEqual(["vendor"]);
  });

  it("returns store: null before applying", async () => {
    const res = await api().get("/api/v1/vendors/me").set(bearer(await newVendor()));
    expect(res.body).toEqual({ store: null });
  });
});

describe("admin review", () => {
  it("lists pending applications oldest first with the owner and status counts", async () => {
    const admin = await signInAdmin(app);
    await apply(await newVendor("first@example.com"), { storeName: "First Store" });
    await apply(await newVendor("second@example.com"), { storeName: "Second Store" });

    const res = await api().get("/api/v1/admin/vendors?status=pending").set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.items.map((v: { storeName: string }) => v.storeName)).toEqual(["First Store", "Second Store"]);
    expect(res.body.items[0].owner.email).toBe("first@example.com");
    expect(res.body.counts).toEqual({ pending: 2, approved: 0, rejected: 0, suspended: 0 });
  });

  it("approves, suspends with a reason and restores a store", async () => {
    const admin = await signInAdmin(app);
    const token = await newVendor();
    const { body } = await apply(token);
    const id = body.store.id as string;

    const approved = await act(admin, id, "approve");
    expect(approved.status).toBe(200);
    expect(approved.body.store).toMatchObject({ status: "approved", approvedAt: expect.any(String) });

    const noReason = await act(admin, id, "suspend");
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details.fields[0].field).toBe("reason");

    const suspended = await act(admin, id, "suspend", { reason: "Counterfeit listings reported" });
    expect(suspended.body.store).toMatchObject({ status: "suspended", rejectionReason: "Counterfeit listings reported" });

    const restored = await act(admin, id, "restore");
    expect(restored.body.store).toMatchObject({ status: "approved", rejectionReason: null });
  });

  it("refuses actions that don't fit the current status", async () => {
    const admin = await signInAdmin(app);
    const { body } = await apply(await newVendor());
    const res = await act(admin, body.store.id, "suspend", { reason: "Not approved yet anyway" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "invalid_transition", details: { status: "pending", allowedFrom: ["approved"] } });

    expect((await act(admin, "0123456789abcdef01234567", "approve")).status).toBe(404);
    expect((await act(admin, "not-an-id", "approve")).status).toBe(404);
  });

  it("lets a rejected vendor see the reason, fix the application and apply again", async () => {
    const admin = await signInAdmin(app);
    const token = await newVendor();
    const { body } = await apply(token, { storeName: "Draft Name" });
    await act(admin, body.store.id, "reject", { reason: "Please add a real store description" });

    const me = await api().get("/api/v1/vendors/me").set(bearer(token));
    expect(me.body.store).toMatchObject({ status: "rejected", rejectionReason: "Please add a real store description" });

    const again = await apply(token, { storeName: "Better Name", description: "Refurbished phones with a 1-year warranty" });
    expect(again.status).toBe(200);
    expect(again.body.store).toMatchObject({ status: "pending", rejectionReason: null, slug: "better-name" });
  });

  it("won't take a new application from an approved store", async () => {
    const admin = await signInAdmin(app);
    const token = await newVendor();
    const { body } = await apply(token);
    await act(admin, body.store.id, "approve");
    const res = await apply(token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_applied");
  });

  it("is admin-only", async () => {
    const token = await newVendor();
    const { body } = await apply(token);
    expect((await act(token, body.store.id, "approve")).status).toBe(403);
    expect((await api().get("/api/v1/admin/vendors").set(bearer(token))).status).toBe(403);
  });
});

describe("store settings", () => {
  it("lets a vendor edit their store but not while it's suspended", async () => {
    const admin = await signInAdmin(app);
    const token = await newVendor();
    const { body } = await apply(token);
    await act(admin, body.store.id, "approve");

    const edited = await api().patch("/api/v1/vendors/me").set(bearer(token)).send({ description: "Now with free delivery" });
    expect(edited.body.store.description).toBe("Now with free delivery");
    // Fields that aren't sent keep their values.
    const phoneOnly = await api().patch("/api/v1/vendors/me").set(bearer(token)).send({ phone: "9811122233" });
    expect(phoneOnly.body.store).toMatchObject({ phone: "9811122233", description: "Now with free delivery", storeName: "Test Electronics" });

    await act(admin, body.store.id, "suspend", { reason: "Under investigation" });
    const blocked = await api().patch("/api/v1/vendors/me").set(bearer(token)).send({ description: "Sneaky edit" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatchObject({ code: "vendor_not_approved", details: { storeStatus: "suspended" } });
  });

  it("only shows approved stores publicly", async () => {
    const admin = await signInAdmin(app);
    const { body } = await apply(await newVendor());
    expect((await api().get(`/api/v1/stores/${body.store.slug}`)).status).toBe(404);

    await act(admin, body.store.id, "approve");
    const page = await api().get(`/api/v1/stores/${body.store.slug}`);
    expect(page.status).toBe(200);
    expect(page.body.store.storeName).toBe("Test Electronics");
    // Contact details and status stay private.
    expect(page.body.store).not.toHaveProperty("phone");
    expect(page.body.store).not.toHaveProperty("status");
  });
});
