import { defineConfig } from "drizzle-kit";
import dotenv from "dotenv";

// The Drizzle CLI runs outside Next.js, so .env.local is not loaded
// automatically — it must be loaded explicitly here.
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Define it in .env.local (see .env.example) before running any drizzle-kit command."
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
