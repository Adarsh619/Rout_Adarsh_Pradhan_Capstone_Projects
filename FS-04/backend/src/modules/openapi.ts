import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";

// The API description (OpenAPI 3) lives in backend/openapi.yaml; a test checks it lists exactly the routes the app
// serves, and `npm run openapi` copies it to docs/openapi.yaml. Served at /api/schema/ and, browsable, /api/docs/.

export const SPEC_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../openapi.yaml");

let cached: { text: string; doc: Record<string, unknown> } | undefined;
export function spec() {
  if (!cached) {
    const text = readFileSync(SPEC_PATH, "utf8");
    cached = { text, doc: YAML.parse(text) as Record<string, unknown> };
  }
  return cached;
}

export function docsRouter(): Router {
  const r = Router();
  r.get("/schema/", (_req, res) => {
    res.type("application/vnd.oai.openapi; charset=utf-8").send(spec().text);
  });
  r.use("/docs", swaggerUi.serveFiles(undefined, { swaggerOptions: { url: "/api/schema/" } }), swaggerUi.setup(undefined, {
    swaggerOptions: { url: "/api/schema/" },
    customSiteTitle: "TaskFlow API",
  }));
  return r;
}
