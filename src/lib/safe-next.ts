const LOCAL = "http://arena.invalid";

/**
 * The return path after login, resolved the way a browser resolves it (which strips tabs and
 * newlines and treats backslashes as slashes) and kept on this site. The value returned is checked
 * again as written, because normalising dot segments can turn "/.//evil.example" into
 * "//evil.example", which a browser reads as another host. Anything unsafe becomes "/".
 */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(value, LOCAL);
  } catch {
    return "/";
  }
  if (url.origin !== LOCAL) return "/";
  const result = `${url.pathname}${url.search}${url.hash}`;
  if (!result.startsWith("/") || result.startsWith("//") || result.startsWith("/\\")) return "/";
  if (new URL(result, LOCAL).origin !== LOCAL) return "/";
  return result;
}
