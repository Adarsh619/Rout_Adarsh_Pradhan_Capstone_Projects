import { defineConfig } from "prisma/config";

// Used by the Prisma CLI (generate, migrate). The app itself reads DATABASE_URL through config/env.ts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://shopsphere:shopsphere@localhost:5433/shopsphere",
  },
});
