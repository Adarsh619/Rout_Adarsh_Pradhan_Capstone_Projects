import { loadEnv } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { connectDb, disconnectDb, prisma } from "../lib/db.js";
import { hashPassword } from "../modules/auth/password.js";
import type { Role } from "../modules/users/user.model.js";

// Creates one demo account per role (and the only way to get an admin). Safe to run again:
// existing accounts keep their data and only get their password and role reset.
//   npm run seed:users                                   (local)
//   docker compose exec api node dist/scripts/seed-users.js
const DEMO_USERS: { name: string; email: string; role: Role }[] = [
  { name: "Asha Admin", email: "admin@shopsphere.test", role: "admin" },
  { name: "Vikram Vendor", email: "vendor@shopsphere.test", role: "vendor" },
  { name: "Priya Customer", email: "customer@shopsphere.test", role: "customer" },
];

async function main() {
  const env = loadEnv();
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error("Set DEMO_PASSWORD (10+ characters, letters and numbers) before seeding demo users");
  }
  await connectDb(env.DATABASE_URL);
  const passwordHash = await hashPassword(password, env.BCRYPT_COST);
  for (const u of DEMO_USERS) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { role: u.role, status: "active", passwordHash },
      create: { name: u.name, email: u.email, role: u.role, passwordHash },
    });
    logger.info({ email: u.email, role: u.role }, "demo user ready");
  }
  await disconnectDb();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "seeding demo users failed");
  process.exit(1);
});
