import { copyFileSync } from "node:fs";
import path from "node:path";
import { SPEC_PATH } from "../modules/openapi.js";

// Copy backend/openapi.yaml to docs/openapi.yaml (the documentation's copy).
const target = path.resolve(path.dirname(SPEC_PATH), "../docs/openapi.yaml");
copyFileSync(SPEC_PATH, target);
console.log(`Wrote ${target}`);
