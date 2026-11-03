import { loadEnv } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { connectMongo, disconnectMongo } from "../lib/mongo.js";
import { hashPassword } from "../modules/auth/password.js";
import { User, type Role } from "../modules/users/user.model.js";

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
  await connectMongo(env.MONGO_URL);
  const passwordHash = await hashPassword(password, env.BCRYPT_COST);
  for (const u of DEMO_USERS) {
    await User.updateOne(
      { email: u.email },
      { $set: { role: u.role, status: "active", passwordHash }, $setOnInsert: { name: u.name, email: u.email } },
      { upsert: true },
    );
    logger.info({ email: u.email, role: u.role }, "demo user ready");
  }
  await disconnectMongo();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "seeding demo users failed");
  process.exit(1);
});
