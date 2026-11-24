import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

// Agent output is untrusted: raw HTML is dropped (skipHtml), the sanitizer strips anything
// dangerous that markdown itself can produce (javascript: links and the like), and images are
// removed entirely so an answer can't load tracking pixels or exfiltrate data through URLs.
const schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== "img"),
};

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: () => null,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="answer">
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, schema]]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
