import "server-only";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { LIMITS } from "@/lib/domain";
import { ApiError } from "./errors";

export function json(data: unknown, status = 200, headers?: Record<string, string>) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json(
      { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
      err.status,
      err.headers,
    );
  }
  console.error("[arena] unhandled error", err);
  return json({ error: { code: "internal", message: "internal server error" } }, 500);
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response> | Response;

/** Wraps a route handler: turns errors into the JSON error envelope and logs one line per request. */
export function route<C = unknown>(handler: Handler<C>): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    const started = Date.now();
    let res: Response;
    try {
      res = await handler(req, ctx);
    } catch (err) {
      // Next signals prerender bail-outs and similar control flow by throwing; let those through.
      unstable_rethrow(err);
      res = errorResponse(err);
    }
    if (process.env.NODE_ENV !== "test") {
      const path = new URL(req.url).pathname;
      console.log(`[arena] ${req.method} ${path} ${res.status} ${Date.now() - started}ms`);
    }
    return res;
  };
}

/** Reads the whole body, failing with 413 past `limit` bytes whether or not Content-Length is sent. */
async function readBodyBytes(req: Request, limit: number): Promise<Buffer> {
  const tooLarge = () => new ApiError(413, "payload_too_large", `body must be at most ${limit} bytes`);
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** For mutations that take no body: still enforces the size limit before any side effect. */
export async function discardBody(req: Request, limit: number = LIMITS.bodyBytes): Promise<null> {
  await readBodyBytes(req, limit);
  return null;
}

/** Reads a JSON body of at most `limit` bytes. An empty body reads as `{}`. */
export async function readJson(req: Request, limit: number = LIMITS.bodyBytes): Promise<unknown> {
  const text = (await readBodyBytes(req, limit)).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "body is not valid JSON");
  }
}

export function parseWith<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "validation_failed",
      "request failed validation",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}
