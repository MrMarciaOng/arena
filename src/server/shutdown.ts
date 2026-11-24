// No "server-only" import: instrumentation.ts loads this outside the React server graph.

/**
 * Open live streams, so a stopping server can end them. Next's graceful shutdown (`server.close()`
 * on SIGTERM/SIGINT) waits for open responses, and a stream would hold it for minutes; ended
 * streams make browsers reconnect, to the restarted server or another instance.
 */
type Holder = { __arenaStreams?: Set<() => void>; __arenaDraining?: boolean };
const holder = globalThis as unknown as Holder;

function streams(): Set<() => void> {
  holder.__arenaStreams ??= new Set();
  return holder.__arenaStreams;
}

/** Registers a stream's close function; returns the unregister function. */
export function trackStream(close: () => void): () => void {
  const set = streams();
  set.add(close);
  return () => set.delete(close);
}

/** True once the server is stopping: new streams are refused so browsers retry elsewhere or later. */
export function isDraining(): boolean {
  return holder.__arenaDraining === true;
}

export function drainStreams(): void {
  holder.__arenaDraining = true;
  for (const close of [...streams()]) close();
}

/** For tests. */
export function resetDraining(): void {
  holder.__arenaDraining = false;
}
