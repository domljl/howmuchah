import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createApp } from "./app.js";

if (existsSync(".env.local")) loadEnvFile(".env.local");
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before starting the API.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined });
try {
  await pool.query(await readFile(resolve("server/schema.sql"), "utf8"));
  const app = await createApp({ pool });
  const close = async () => { await app.close(); await pool.end(); };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8787) });
} catch (error) {
  await pool.end();
  throw error;
}
