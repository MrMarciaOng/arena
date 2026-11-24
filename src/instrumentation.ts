export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const { assertStartupConfig } = await import("./server/env");
    assertStartupConfig();
    // End live streams so Next can finish closing open responses during graceful shutdown.
    // With NEXT_MANUAL_SIG_HANDLE, the app owns the signals instead.
    if (!process.env.NEXT_MANUAL_SIG_HANDLE) {
      const { drainStreams } = await import("./server/shutdown");
      process.once("SIGTERM", drainStreams);
      process.once("SIGINT", drainStreams);
    }
  }
}
