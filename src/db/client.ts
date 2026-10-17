import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

let pool: Pool | null = null;

export function getDb() {
  if (!pool) {
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ??
        "postgres://zyntra:zyntra@localhost:5432/zyntra",
      max: 10,
    });
    pool.on("error", (e) => console.error("[db] pool error", e));
  }
  return drizzle(pool, { schema });
}

export async function dbAvailable(): Promise<boolean> {
  try {
    const db = getDb();
    await db.execute("select 1" as never);
    return true;
  } catch {
    return false;
  }
}
