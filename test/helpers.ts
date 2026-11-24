import type { PgTable } from "drizzle-orm/pg-core";
import { ADMIN_TOKEN, OWNER_PASSWORD, SESSION_SECRET } from "./constants";
import { getDb, openDb, setDbForTests } from "@/server/db/client";
import { createSessionValue, SESSION_COOKIE } from "@/server/session";

export { ADMIN_TOKEN };

type Init = { body?: unknown; token?: string; cookie?: string; headers?: Record<string, string>; raw?: string };

export function req(method: string, path: string, init: Init = {}): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.cookie) headers.cookie = init.cookie;
  let body: string | undefined = init.raw;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`http://localhost${path}`, { method, headers, body });
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

// Tests poke at arbitrary JSON shapes, so the result is deliberately loose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function read(res: Response): Promise<any> {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function ownerCookie(nowMs = Date.now()): Promise<string> {
  const value = await createSessionValue({ secret: SESSION_SECRET, password: OWNER_PASSWORD }, nowMs);
  return `${SESSION_COOKIE}=${value}`;
}

/** Every row of a table, for assertions. */
export async function rows<T extends PgTable>(table: T): Promise<T["$inferSelect"][]> {
  return (await getDb()).select().from(table as PgTable) as Promise<T["$inferSelect"][]>;
}

/** Swaps in a database that fails every query (the next test gets the real one back). */
export async function useBrokenDb(): Promise<void> {
  const broken = await openDb("pglite:memory", { migrate: false });
  await broken.close();
  setDbForTests(broken);
}
