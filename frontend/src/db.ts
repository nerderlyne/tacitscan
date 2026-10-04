import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

// Bound concurrency to four connections; independent SSR reads can overlap.
const client = postgres(url, {
  max: 4,
  idle_timeout: 20,
  prepare: false,
});

export const db = drizzle(client, { schema });
export { schema };
