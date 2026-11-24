import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/domain";
import { decideOrdering, heartbeat, reportStatus, truncateUtf8 } from "./agents";
import { createArena, getArena } from "./arenas";
import { rows } from "../../test/helpers";
import { events } from "./db/schema";
import { pruneEvents } from "./events";

describe("truncateUtf8", () => {
  it("leaves short text alone", async () => {
    expect(truncateUtf8("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  it("never splits a multi-byte character", async () => {
    // "€" is 3 bytes; 4 bytes fit one and a third.
    expect(truncateUtf8("€€", 4)).toEqual({ text: "€", truncated: true });
    expect(truncateUtf8("a😀b", 3)).toEqual({ text: "a", truncated: true });
  });
});

describe("decideOrdering", () => {
  const fresh = { session: null, seqWatermark: null };

  it("applies without seq and keeps the watermark", async () => {
    expect(decideOrdering({ session: "s", seqWatermark: 5 }, {})).toEqual({ applied: true, session: "s", seqWatermark: 5 });
  });

  it("applies the first sequenced report", async () => {
    expect(decideOrdering(fresh, { session: "s", seq: 1 })).toEqual({ applied: true, session: "s", seqWatermark: 1 });
  });

  it("resets on a new session even with a lower seq", async () => {
    expect(decideOrdering({ session: "a", seqWatermark: 100 }, { session: "b", seq: 1 })).toEqual({
      applied: true,
      session: "b",
      seqWatermark: 1,
    });
  });

  it("supersedes equal or lower seq in the same session", async () => {
    expect(decideOrdering({ session: "a", seqWatermark: 100 }, { session: "a", seq: 100 }).applied).toBe(false);
    expect(decideOrdering({ session: "a", seqWatermark: 100 }, { session: "a", seq: 99 }).applied).toBe(false);
  });
});

describe("pruneEvents", () => {
  it("keeps the newest events per agent and drops old ones", async () => {
    await createArena({ slug: "career", name: "Career", theme: "office" }, 0);
    const arena = await getArena("career");
    const start = Date.now() - LIMITS.eventMaxAgeMs - 1000;
    await reportStatus(arena, "old", { status: "idle" }, start); // registered + status, both too old
    for (let i = 0; i < LIMITS.eventsPerAgent + 20; i += 1) {
      await reportStatus(arena, "busy", { status: "working", activity: `step ${i}` }, Date.now());
    }
    await pruneEvents(Date.now());
    const all = await rows(events);
    expect(all.filter((e) => e.agentKey === "old")).toHaveLength(0);
    const busy = all.filter((e) => e.agentKey === "busy");
    expect(busy).toHaveLength(LIMITS.eventsPerAgent);
    expect(busy.some((e) => (e.report as { activity?: string } | null)?.activity === `step ${LIMITS.eventsPerAgent + 19}`)).toBe(true);
  });

  it("runs after presence-only writes too", async () => {
    await createArena({ slug: "quiet", name: "Quiet", theme: "office" }, 0);
    const arena = await getArena("quiet");
    const old = Date.now() - LIMITS.eventMaxAgeMs - 120_000;
    await reportStatus(arena, "bot", { status: "idle" }, old);
    expect((await rows(events))).toHaveLength(2);
    await heartbeat(arena, "bot", {}, Date.now());
    expect((await rows(events))).toHaveLength(0);
  });
});
