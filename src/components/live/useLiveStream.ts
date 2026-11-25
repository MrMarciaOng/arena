"use client";

import { useRouter } from "next/navigation";
import { useEffect, useReducer, useState } from "react";
import type { StreamMessage } from "@/lib/domain";
import { initialLiveState, liveReducer, type LiveState } from "@/lib/live-state";

/**
 * Follows /api/stream (`arenas` null follows every arena). Every connection starts with a fresh
 * snapshot. On a "reconnect" message (the server's time limit is near) it opens a new connection
 * straight away, without showing "reconnecting". EventSource reconnects on its own after a dropped
 * connection; if the server refuses the connection outright (EventSource stays closed), we check
 * whether the session expired and retry.
 */
export function useLiveStream(arenas: string[] | null): LiveState & { retry: () => void } {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState);
  const [attempt, nextAttempt] = useReducer((current: number) => current + 1, 0);
  const router = useRouter();
  const query = arenas ? `?arenas=${encodeURIComponent(arenas.join(","))}` : "";

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const open = () => {
      const current = new EventSource(`/api/stream${query}`);
      source = current;
      current.onmessage = (event) => {
        const message = JSON.parse(event.data) as StreamMessage;
        if (message.type === "reconnect") {
          // The server is about to end this connection (a time limit): switch to a new one now,
          // quietly; it starts with a fresh snapshot.
          current.close();
          if (!stopped) open();
          return;
        }
        dispatch({ type: "message", message, clientNowMs: Date.now() });
      };
      current.onerror = () => {
        if (source !== current) return; // an old connection we already replaced
        dispatch({ type: "disconnected" });
        if (current.readyState !== EventSource.CLOSED) return; // the browser is already retrying
        current.close();
        // HEAD runs the same checks as the stream without opening one.
        void fetch(`/api/stream${query}`, { method: "HEAD" })
          .then((res) => {
            void res.body?.cancel();
            if (stopped) return;
            if (res.status === 401) {
              stopped = true;
              const { pathname, search, hash } = window.location;
              router.replace(`/login?next=${encodeURIComponent(pathname + search + hash)}`);
              return;
            }
            // A request the server will never accept (bad slug, no permission): stop retrying.
            if (res.status === 400 || res.status === 403 || res.status === 404) {
              stopped = true;
              dispatch({ type: "failed" });
            }
          })
          .catch(() => {})
          .finally(() => {
            if (!stopped) retryTimer = setTimeout(open, 3000);
          });
      };
    };

    open();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [attempt, query, router]);

  return {
    ...state,
    retry() {
      dispatch({ type: "retry" });
      nextAttempt();
    },
  };
}

/** Re-renders every `intervalMs` so presence ("away", "last seen") stays current without server events. */
export function useNow(intervalMs = 5000, clockOffsetMs = 0): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now() + clockOffsetMs);
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [intervalMs, clockOffsetMs]);
  return now;
}
