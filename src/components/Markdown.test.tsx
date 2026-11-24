import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders hostile agent output inert", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={[
          "<script>alert(1)</script>",
          '<img src="https://tracker.example/p.gif" onerror="alert(1)">',
          "[click](javascript:alert(1))",
          "![pixel](https://tracker.example/q.gif)",
          '<a href="https://x.example" onclick="alert(1)">raw</a>',
        ].join("\n\n")}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.example");
  });

  it("renders ordinary markdown, with safe external links", () => {
    const html = renderToStaticMarkup(<Markdown text={"## Title\n\n- **bold** item\n\n[docs](https://example.com)"} />);
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});
