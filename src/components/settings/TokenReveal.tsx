"use client";

import { useState, useSyncExternalStore } from "react";

const noop = () => () => {};

/** Shows a new API key with a copy button and a ready-to-run curl command. */
export function TokenReveal({ slug, token, note }: { slug: string; token: string; note?: string }) {
  const origin = useSyncExternalStore(noop, () => window.location.origin, () => "http://localhost:3000");
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(token);
      setCopyNote("Copied.");
    } catch {
      setCopyNote("Copying needs HTTPS here. Select the token and copy it instead.");
    }
  };
  const curl = `curl -X POST ${origin}/api/arenas/${slug}/agents/my-agent/status \\
  -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \\
  -d '{"status":"working","activity":"Hello from my agent"}'`;
  return (
    <div className="mt-3 border-2 border-waiting bg-ink p-3 text-sm" role="status">
      <p className="font-pixel text-waiting">{note ?? "Here is the API key. You can copy it again from Settings."}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all text-xs" data-testid="ingest-token">
          {token}
        </code>
        <button type="button" className="pixel-button text-xs" onClick={() => void copy()}>
          Copy
        </button>
      </div>
      {copyNote ? <p className="mt-1 text-xs text-muted">{copyNote}</p> : null}
      <p className="mt-3 text-muted">Try it:</p>
      <pre className="mt-1 overflow-x-auto text-xs">{curl}</pre>
    </div>
  );
}
