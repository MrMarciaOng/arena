"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";

const noop = () => () => {};

/** Shows a new API key with a copy button, a ready-to-run curl command and the way to set up agents with it. */
export function TokenReveal({ slug, token, keyId, note }: { slug: string; token: string; keyId?: string; note?: string }) {
  const origin = useSyncExternalStore(noop, () => window.location.origin, () => "http://localhost:3000");
  const [copyResult, setCopyResult] = useState<{ item: "key" | "command"; copied: boolean } | null>(null);
  const curl = `curl -X POST ${origin}/api/arenas/${slug}/agents/my-agent/status \\
  -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \\
  -d '{"status":"working","activity":"Hello from my agent"}'`;
  async function copy(item: "key" | "command") {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(item === "key" ? token : curl);
      setCopyResult({ item, copied: true });
    } catch {
      setCopyResult({ item, copied: false });
    }
  }
  const useCommandField = copyResult?.item === "command" && !copyResult.copied;
  return (
    <div className="mt-3 border-2 border-waiting bg-ink p-3 text-sm">
      <p className="font-pixel text-waiting">{note ?? "Here is the API key. You can copy it again from Settings."}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all text-xs" data-testid="ingest-token">
          {token}
        </code>
        <button type="button" className="pixel-button shrink-0 text-xs" onClick={() => void copy("key")}>
          Copy key
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted">Sample report</p>
        <button type="button" className="pixel-button text-xs" onClick={() => void copy("command")}>Copy command</button>
      </div>
      {useCommandField ? (
        <textarea
          aria-label="Reporting command"
          readOnly
          rows={3}
          wrap="off"
          value={curl}
          onFocus={(event) => event.currentTarget.select()}
          className="mt-1 w-full bg-ink font-mono text-xs"
        />
      ) : <pre className="mt-1 overflow-x-auto text-xs">{curl}</pre>}
      {keyId ? (
        <p className="mt-3">
          <Link href={`/arenas/${slug}/connect?key=${encodeURIComponent(keyId)}`} className="text-done underline underline-offset-4">
            Connect Claude Code, Codex or another AI with this key
          </Link>
        </p>
      ) : null}
      <p role="status" className="mt-1 text-xs text-muted">
        {copyResult?.copied ? (copyResult.item === "key" ? "API key copied." : "Command copied.") : copyResult
          ? (copyResult.item === "key" ? "Select the key and copy it manually." : "Select the command and copy it manually.")
          : null}
      </p>
    </div>
  );
}
