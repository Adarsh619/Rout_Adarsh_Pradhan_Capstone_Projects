import { defineConfig } from "prisma/config";

// Used by the Prisma CLI (generate, migrate). The app reads DATABASE_URL through src/config.ts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://taskflow:taskflow@localhost:5432/taskflow",
  },
});
