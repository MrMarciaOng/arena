import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/server/db/client";
import { json, route } from "@/server/http";

export const GET = route(async () => {
  await connection();
  await (await getDb()).execute(sql`SELECT 1`);
  return json({ ok: true });
});
