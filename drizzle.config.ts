import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/data/schema-pg.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://commander:ddbb464f3cae9fe857f085d015382eed@localhost:5433/commander",
  },
});
