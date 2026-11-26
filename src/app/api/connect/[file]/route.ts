import { connection } from "next/server";
import { readConnectFile } from "@/server/connect-files";
import { notFound } from "@/server/errors";
import { route } from "@/server/http";

type FileParams = { params: Promise<{ file: string }> };

/**
 * The scripts and skill files that the Connect page's install command downloads. Public: they
 * hold no secrets. Plain text with nosniff, so a browser shows them rather than running them.
 */
export const GET = route<FileParams>(async (req, ctx) => {
  await connection();
  const { file } = await ctx.params;
  const text = await readConnectFile(file, new URL(req.url).origin);
  if (text === null) throw notFound("file");
  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    },
  });
});
