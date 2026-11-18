import { config } from "../config.js";
import { connectDb, disconnectDb } from "../lib/db.js";
import { SeedRefused, seedDemo } from "../modules/demo/seed.js";

// Demo data:  node dist/scripts/seed-demo.js [--issues 60] [--reset] [--force]
const args = process.argv.slice(2);
const at = args.indexOf("--issues");
const issues = at >= 0 ? Number(args[at + 1]) : 60;

await connectDb(config.DATABASE_URL);
try {
  await seedDemo({ issues, reset: args.includes("--reset"), force: args.includes("--force"), log: (l) => console.log(l) });
} catch (err) {
  if (!(err instanceof SeedRefused)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
