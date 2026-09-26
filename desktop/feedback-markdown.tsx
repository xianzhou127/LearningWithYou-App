import { memo } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

const plugins = [remarkGfm, remarkMath];
// Chromium renders native MathML: no remote fonts, HTML layout styles or CSP relaxation.
// Keep macros local to each expression and disallow URL/HTML commands from model output.
const mathPlugins: Options["rehypePlugins"] = [[rehypeKatex, {
  output: "mathml", trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20,
}]];
const components: Components = {
  // Model output may format references, but cannot navigate or load remote media.
  a: ({ children, href }) => <span className="feedback-reference" title={href}>{children}</span>,
  img: ({ alt }) => <span className="feedback-image-label">[图片{alt ? `：${alt}` : ""}]</span>,
  table: ({ children }) => <div className="feedback-table-scroll" tabIndex={0} role="region" aria-label="反馈表格"><table>{children}</table></div>,
};

export const FeedbackMarkdown = memo(function FeedbackMarkdown({ text }: { text: string }) {
  // Keep raw HTML escaped; never enable rehype-raw or dangerouslySetInnerHTML here.
  return <div className="result-text feedback-markdown"><Markdown remarkPlugins={plugins} rehypePlugins={mathPlugins} components={components}>{text}</Markdown></div>;
});
