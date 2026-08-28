import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma 7 tirou a connection string do schema.prisma. O CLI (migrate,
// studio, db push) le a URL daqui; o runtime usa o adapter em
// src/core/db/cliente.ts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
