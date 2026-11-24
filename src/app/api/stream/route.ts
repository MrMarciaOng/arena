import { unstable_rethrow } from "next/navigation";
import type { StreamMessage, StreamSnapshot } from "@/lib/domain";
import { slugSchema } from "@/lib/schemas";
import { assertCanReadAll, resolveReader, type Credential } from "@/server/auth";
import { errorResponse, parseWith } from "@/server/http";
import { readChanges, type FeedMessage } from "@/server/feed";
import { isDraining, trackStream } from "@/server/shutdown";
import { readSnapshot } from "@/server/snapshot";

/**
 * Vercel ends a function after its maximum duration, so a stream can't stay open forever. Each
 * connection ends itself a little before that with a "reconnect" message; the browser reopens at
 * once and starts again from a fresh snapshot.
 */
export const maxDuration = 300;

const PING_MS = 15_000;
const pollMs = () => Number(process.env.ARENA_STREAM_POLL_MS ?? 1000);
const lifetimeMs = () => Number(process.env.ARENA_STREAM_SECONDS ?? 240) * 1000;
/** A client this far behind is dropped; it reconnects and catches up from a fresh snapshot. */
const maxBacklogBytes = () => Number(process.env.ARENA_STREAM_BACKLOG_BYTES ?? 4 * 1024 * 1024);
const HIGH_WATER_MARK = 64 * 1024;
const FEED_BATCH = 500;
/** setTimeout's ceiling (~24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-store, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function logRequest(req: Request, status: number, started: number) {
  if (process.env.NODE_ENV === "test") return;
  console.log(`[arena] ${req.method} ${new URL(req.url).pathname} ${status} ${Date.now() - started}ms`);
}

async function authorize(req: Request): Promise<{ cred: Credential; slugs: string[] | null }> {
  const cred = await resolveReader(req);
  assertCanReadAll(cred);
  const param = new URL(req.url).searchParams.get("arenas");
  const slugs = param ? param.split(",").filter(Boolean).map((s) => parseWith(slugSchema, s)) : null;
  return { cred, slugs };
}

/**
 * While this server stops, stream requests get 503 and their connection is closed. A browser
 * retries every few seconds over its kept-alive connection, which would otherwise never go idle
 * and would hold the shutdown open.
 */
function draining(req: Request, started: number): Response {
  logRequest(req, 503, started);
  return new Response(null, { status: 503, headers: { "Retry-After": "3", Connection: "close" } });
}

/** HEAD gets the same checks and headers but never opens a stream. */
export async function HEAD(req: Request) {
  const started = Date.now();
  if (isDraining()) return draining(req, started);
  try {
    await authorize(req);
    logRequest(req, 200, started);
    return new Response(null, { headers: SSE_HEADERS });
  } catch (err) {
    unstable_rethrow(err);
    const res = errorResponse(err);
    logRequest(req, res.status, started);
    return new Response(null, { status: res.status, headers: res.headers });
  }
}

/** Which feed messages a connection following `slugs` (null: every arena) should see. */
function follower(slugs: string[] | null, snapshot: StreamSnapshot) {
  const arenaIds = slugs ? new Set(snapshot.arenas.map((a) => a.id)) : null;
  const reset = (next: StreamSnapshot) => {
    if (!arenaIds) return;
    arenaIds.clear();
    for (const a of next.arenas) arenaIds.add(a.id);
  };
  const relevant = (msg: FeedMessage): boolean => {
    if (!slugs || !arenaIds) return true;
    switch (msg.type) {
      case "arena.upserted":
        // An arena created after we connected can match a requested slug.
        if (slugs.includes(msg.arena.slug)) arenaIds.add(msg.arena.id);
        return arenaIds.has(msg.arena.id);
      case "arena.removed":
        return arenaIds.has(msg.arenaId);
      case "agent.upserted":
        return arenaIds.has(msg.agent.arenaId);
      default:
        return arenaIds.has(msg.arenaId);
    }
  };
  return { relevant, reset };
}

/**
 * Live updates over Server-Sent Events. Every connection starts with a full snapshot, then follows
 * the change feed in Postgres from the snapshot's `seq`. The feed is shared by every server
 * instance, so it doesn't matter which instance took a write and which one serves the stream.
 */
export async function GET(req: Request) {
  const started = Date.now();
  if (isDraining()) return draining(req, started);
  let cred: Credential;
  let slugs: string[] | null;
  let snapshot: StreamSnapshot;
  try {
    ({ cred, slugs } = await authorize(req));
    snapshot = await readSnapshot(slugs, Date.now());
  } catch (err) {
    unstable_rethrow(err);
    const res = errorResponse(err);
    logRequest(req, res.status, started);
    return res;
  }
  if (req.signal.aborted) return new Response(null, { status: 499 });

  const { relevant, reset } = follower(slugs, snapshot);
  const encoder = new TextEncoder();
  let close = () => {};
  let settleAllowance = () => {};

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        let overflowed = false;
        let cursor = snapshot.seq;
        // The snapshot may be large on its own; the backlog limit applies to what comes after it.
        // Bytes read by the client = bytes enqueued − bytes still queued; once that covers the
        // snapshot, its extra allowance is gone, however much else is queued behind it.
        let allowance = maxBacklogBytes();
        let snapshotBytes = 0;
        let enqueued = 0;
        settleAllowance = () => {
          if (snapshotBytes === 0) return;
          const queued = HIGH_WATER_MARK - (controller.desiredSize ?? 0);
          if (enqueued - queued >= snapshotBytes) {
            snapshotBytes = 0;
            allowance = maxBacklogBytes();
          }
        };
        const write = (text: string) => {
          if (closed) return;
          const chunk = encoder.encode(text);
          try {
            controller.enqueue(chunk);
          } catch {
            close();
            return;
          }
          enqueued += chunk.byteLength;
          settleAllowance();
          // enqueue() never fails on backpressure; drop a client that has fallen too far behind.
          // Erroring the stream (not closing it) discards the queued backlog.
          if ((controller.desiredSize ?? 0) < -allowance) {
            overflowed = true;
            close();
          }
        };
        const send = (msg: StreamMessage) => write(`data: ${JSON.stringify(msg)}\n\n`);
        const sendSnapshot = (snap: StreamSnapshot) => {
          const text = `data: ${JSON.stringify(snap)}\n\n`;
          snapshotBytes = encoder.encode(text).byteLength;
          allowance = maxBacklogBytes() + snapshotBytes;
          write(text);
        };

        write("retry: 3000\n\n");
        sendSnapshot(snapshot);

        // Follow the feed. One poll at a time; a full batch means more is waiting, so poll again now.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
          if (closed) return;
          let more = false;
          try {
            const { messages, gap } = await readChanges(cursor, FEED_BATCH);
            if (closed) return;
            if (gap) {
              // The feed was pruned past our cursor: start over from a fresh snapshot.
              const fresh = await readSnapshot(slugs, Date.now());
              if (closed) return;
              reset(fresh);
              cursor = fresh.seq;
              sendSnapshot(fresh);
            } else {
              for (const msg of messages) {
                cursor = Math.max(cursor, msg.seq);
                if (relevant(msg)) send(msg);
              }
              more = messages.length === FEED_BATCH;
            }
          } catch (err) {
            console.error("[arena] stream poll failed", err);
          }
          if (!closed) timer = setTimeout(() => void poll(), more ? 0 : pollMs());
        };
        timer = setTimeout(() => void poll(), pollMs());

        const ping = setInterval(() => write(": ping\n\n"), PING_MS);
        // End before the platform's limit, telling the browser to reconnect right away.
        const lifetime = setTimeout(() => {
          send({ type: "reconnect" });
          close();
        }, lifetimeMs());
        // An owner stream ends when the session does; the reconnect re-checks the cookie.
        const expiry =
          cred.kind === "owner"
            ? setTimeout(() => close(), Math.min(Math.max(0, cred.expiresAt - Date.now()), MAX_TIMER_MS))
            : undefined;
        const onAbort = () => close();
        const untrack = trackStream(() => close());
        close = () => {
          if (closed) return;
          closed = true;
          untrack();
          clearTimeout(timer);
          clearInterval(ping);
          clearTimeout(lifetime);
          clearTimeout(expiry);
          req.signal.removeEventListener("abort", onAbort);
          try {
            if (overflowed) controller.error(new Error("client fell too far behind"));
            else controller.close();
          } catch {
            // already closed
          }
        };
        req.signal.addEventListener("abort", onAbort);
        if (req.signal.aborted) close();
      },
      // Called as the client reads; a chance to retire the snapshot's allowance.
      pull() {
        settleAllowance();
      },
      cancel() {
        close();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER_MARK }),
  );

  logRequest(req, 200, started);
  return new Response(stream, { headers: SSE_HEADERS });
}
