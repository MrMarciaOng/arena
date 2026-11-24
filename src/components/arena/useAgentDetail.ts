"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDetail, AgentEvent } from "@/lib/domain";

export type Detail = { agent: AgentDetail; events: AgentEvent[] };

/** History can change without a new version (a late report is recorded but not applied). */
const PRESENCE_REFRESH_MS = 10_000;

/**
 * The full answer and history for one agent, while its drawer is open.
 *
 * - A new version refetches at once; if a fetch is in flight it runs again right after it.
 * - A presence-only change (a heartbeat, or a late report that only touched history) refetches no
 *   sooner than 10 s after the last fetch started, and never back to back.
 * - A refresh never cancels the fetch in flight (so frequent heartbeats can't starve a slow one),
 *   but closing the drawer aborts it and drops anything queued.
 */
export function useAgentDetail(slug: string, agentId: string, key: string, version: number, lastSeenAt: string) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<{ id: object; promise: Promise<Detail | null> } | null>(null);
  const rerun = useRef(false);
  const presencePending = useRef(false);
  const lastStarted = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Aborted when the drawer closes (or Strict Mode replays effects); each load run gets the current one. */
  const lifetime = useRef<AbortController>(new AbortController());
  // The latest load(), for timers scheduled before it was (re)created.
  const loadRef = useRef<() => Promise<Detail | null>>(async () => null);

  useEffect(() => {
    const c = new AbortController();
    lifetime.current = c;
    return () => {
      c.abort();
      clearTimeout(timer.current);
      // Detach whatever was in flight so the next setup starts its own request instead of joining
      // one that was just aborted.
      inflight.current = null;
      rerun.current = false;
      presencePending.current = false;
    };
  }, []);

  const fetchOnce = useCallback(async (signal: AbortSignal): Promise<Detail | null> => {
    lastStarted.current = Date.now();
    const res = await fetch(`/api/arenas/${encodeURIComponent(slug)}/agents/${encodeURIComponent(key)}`, {
      cache: "no-store",
      signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? `HTTP ${res.status}`);
    const d = (await res.json()) as Detail;
    return d.agent.id === agentId ? d : null;
  }, [slug, key, agentId]);

  const schedulePresenceRefresh = useCallback((run: () => void) => {
    clearTimeout(timer.current);
    const wait = Math.max(0, lastStarted.current + PRESENCE_REFRESH_MS - Date.now());
    timer.current = setTimeout(run, wait);
  }, []);

  /** Loads now, or right after the fetch in flight. Resolves with the newest detail (null on failure). */
  const load = useCallback((): Promise<Detail | null> => {
    if (inflight.current) {
      rerun.current = true;
      return inflight.current.promise;
    }
    const signal = lifetime.current.signal;
    const id = {};
    const promise = (async () => {
      let latest: Detail | null = null;
      try {
        do {
          rerun.current = false;
          latest = await fetchOnce(signal);
          if (latest && !signal.aborted) {
            setDetail(latest);
            setError(null);
          }
        } while (rerun.current && !signal.aborted);
      } catch (err) {
        if (!signal.aborted) setError(err instanceof Error ? err.message : String(err));
        latest = null;
      } finally {
        // Only clear our own entry: after a cleanup a newer run may already be in flight.
        if (inflight.current?.id === id) inflight.current = null;
      }
      // Presence changed while we were fetching: pick it up after the usual interval.
      if (presencePending.current && !signal.aborted) {
        presencePending.current = false;
        schedulePresenceRefresh(() => void loadRef.current());
      }
      return latest;
    })();
    inflight.current = { id, promise };
    return promise;
  }, [fetchOnce, schedulePresenceRefresh]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const firstSeen = useRef(lastSeenAt);
  useEffect(() => {
    if (lastSeenAt === firstSeen.current) return;
    if (inflight.current) presencePending.current = true;
    else schedulePresenceRefresh(() => void loadRef.current());
  }, [lastSeenAt, schedulePresenceRefresh]);

  return { detail, error, load };
}
