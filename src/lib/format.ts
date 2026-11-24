/** "now", "45s", "12m", "3h", "2d". */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function since(iso: string, nowMs: number): string {
  const d = shortDuration(nowMs - Date.parse(iso));
  return d === "now" ? "just now" : `${d} ago`;
}

/** A stable 32-bit hash for picking colors from an agent key. */
export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A one-line plain-text version of a markdown snippet, for previews. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~)[^\n]*$/gm, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
