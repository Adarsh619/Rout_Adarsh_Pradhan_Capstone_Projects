import { describe, expect, it } from "vitest";
import { UNKNOWN_ENDPOINT } from "../src/app.js";
import { spec } from "../src/modules/openapi.js";
import { anon, world } from "./helpers.js";

// The API description (backend/openapi.yaml, copied to docs/openapi.yaml) must match the routes the app serves.

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

describe("OpenAPI document", () => {
  it("every documented endpoint and method is served", async () => {
    const { api } = await world();
    const paths = spec().doc.paths as Record<string, Record<string, unknown>>;
    const missing: string[] = [];
    let checked = 0;
    for (const [path, ops] of Object.entries(paths)) {
      const url = path.replace("{id}", "999999").replace("{slug}", "acme");
      for (const method of METHODS.filter((m) => m in ops)) {
        const r = await api[method === "delete" ? "delete" : method](url);
        checked++;
        if (r.status === 404 && r.body?.detail === UNKNOWN_ENDPOINT) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(80);
  });

  it("is served at /api/schema/ and browsable at /api/docs/", async () => {
    const c = await anon();
    const schema = await c.get("/api/schema/");
    expect(schema.status).toBe(200);
    expect(schema.text).toContain("openapi: 3.0.3");
    expect((await c.get("/api/docs/")).text).toContain("swagger");
  });

  it("describes the billing endpoints in full", () => {
    const doc = spec().doc as { paths: Record<string, Record<string, { requestBody?: unknown; responses: object }>>; components: { schemas: Record<string, { properties: object }> } };
    const checkout = doc.paths["/api/billing/checkout/"]!.post!;
    expect(checkout.requestBody).toBeTruthy();
    expect(checkout.responses).toHaveProperty("200");
    expect(Object.keys(doc.components.schemas.BillingOverview!.properties)).toEqual(
      expect.arrayContaining(["plan", "effective_plan", "limits", "usage", "can_manage"]),
    );
  });

  it("an unknown URL says so", async () => {
    const { api } = await world();
    const r = await api.get("/api/nothing-here/");
    expect(r.status).toBe(404);
    expect(r.body.detail).toBe(UNKNOWN_ENDPOINT);
  });
});
