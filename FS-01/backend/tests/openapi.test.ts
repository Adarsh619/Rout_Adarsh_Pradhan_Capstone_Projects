import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Keeps docs/openapi.yaml honest: it parses, every $ref points somewhere, and it lists exactly the routes the code has.
const ROOT = join(import.meta.dirname, "..");
const spec = parse(readFileSync(join(ROOT, "../docs/openapi.yaml"), "utf8")) as {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components: Record<string, Record<string, unknown>>;
};

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

// "METHOD /path" for every route the code registers, in OpenAPI style (/:id → /{id}).
function codeRoutes(): Set<string> {
  const mounts: Record<string, string> = { auth: "/auth", account: "/account" };
  const routes = new Set<string>();
  for (const file of sourceFiles(join(ROOT, "src/modules"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(router|auth|account)\.(get|post|put|patch|delete)\(\s*[`"]([^`"]+)[`"]/g)) {
      const [, owner, method, raw] = m;
      const path = `${mounts[owner!] ?? ""}${raw === "/" && owner !== "router" ? "" : raw}`;
      // The four admin store actions are registered in a loop: /admin/vendors/:id/${action}.
      const openapi = path.replace("${action}", "{action}").replace(/:(\w+)/g, "{$1}");
      routes.add(`${method!.toUpperCase()} ${openapi}`);
    }
  }
  routes.add("GET /health");
  return routes;
}

function specRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) if (item[method]) routes.add(`${method.toUpperCase()} ${path}`);
  }
  return routes;
}

describe("OpenAPI spec (docs/openapi.yaml)", () => {
  it("is OpenAPI 3.1", () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
  });

  it("resolves every $ref", () => {
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
    expect(refs.length).toBeGreaterThan(50);
    const missing = refs.filter(([, kind, name]) => !spec.components[kind!]?.[name!]).map(([ref]) => ref);
    expect(missing).toEqual([]);
  });

  it("documents exactly the routes the API has", () => {
    const code = codeRoutes();
    const documented = specRoutes();
    expect(code.size).toBeGreaterThanOrEqual(65);
    expect([...code].filter((r) => !documented.has(r)).sort(), "routes missing from the spec").toEqual([]);
    expect([...documented].filter((r) => !code.has(r)).sort(), "spec paths the code doesn't have").toEqual([]);
  });
});
