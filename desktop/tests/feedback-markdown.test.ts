import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedbackMarkdown } from "../feedback-markdown";

const render = (text: string) => renderToStaticMarkup(createElement(FeedbackMarkdown, { text }));

test("feedback renders Markdown structure including nested lists, tables, emphasis and code", () => {
  const html = render("## 本轮反馈\n\n**电流相同**，但 *电压不同*。\n\n1. 第一点\n   - 子项\n2. 第二点\n\n> 注意条件\n\n| 量 | 关系 |\n| --- | --- |\n| 电流 | 相同 |\n\n`I = U / R`\n\n```js\nconst value = '**原样代码**';\n```\n\n~~旧说法~~\n\n- [x] 已确认\n");
  for (const part of ["<h2>本轮反馈</h2>", "<strong>电流相同</strong>", "<em>电压不同</em>", "<ol>", "<ul>", "<blockquote>", "<table>", "<th>量</th>", "<td>相同</td>", "<code>I = U / R</code>", "<pre><code", "**原样代码**", "<del>旧说法</del>", 'type="checkbox" disabled="" checked=""']) assert.ok(html.includes(part), part);
  assert.ok(!html.includes("## 本轮反馈"));
});

test("feedback escapes raw HTML and prevents model-provided navigation and image requests", () => {
  const html = render('<script>alert(1)</script>\n\n<img src="https://example.com/private" onerror="alert(2)">\n\n[链接](https://example.com) [危险](javascript:alert%281%29) ![远程图片](https://example.com/image.png)');
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("[图片：远程图片]"));
  assert.doesNotMatch(html, /<(?:script|img|iframe|a)\b|\s(?:href|src|onerror)="|javascript:/i);
});

test("plain feedback, line breaks, angle comparisons and escaped Markdown keep their full text", () => {
  const text = "第一句：A < B。\n第二句完整。\n\n最后一段，保留末尾。";
  const html = render(text);
  assert.ok(html.includes("第一句：A &lt; B。\n第二句完整。"));
  assert.ok(html.includes("<p>最后一段，保留末尾。</p>"));
  assert.ok(render("\\*原文星号\\*").includes("<p>*原文星号*</p>"));
});

test("the reported Chinese paragraph renders emphasis and every inline formula without changing the source", () => {
  const text = String.raw`**补充**：这里的 $N$ 对应算法中的 $n$（accepted guesses 的数量）。如果 $n=\gamma$（全部接受），则不需要修正分布，直接从 $M\_p$ 采样；只有当 $n < \gamma$ 时才触发这个修正逻辑。`;
  const html = render(text);
  assert.match(html, /<strong>补充<\/strong>/);
  assert.equal((html.match(/<math\b/g) ?? []).length, 5);
  assert.match(html, /<mi>γ<\/mi>/); assert.match(html, /<mo>&lt;<\/mo>/);
  assert.match(html, /才触发这个修正逻辑。/);
  assert.doesNotMatch(html, /\$|class="katex-error"/);
  assert.ok(text.includes(String.raw`$M\_p$`)); // Escaped underscore remains a literal underscore in TeX.
});

test("math supports subscripts, fractions, blocks, lists and tables while code and escaped dollars stay literal", () => {
  const html = render(String.raw`正文中的 $M_p$ 与 $x^2$，**强调 $N$**。

- 条件 $n < \gamma$

| 变量 | 公式 |
| --- | --- |
| 概率 | $\frac{p}{q}$ |

$$
\sum_{i=1}^{n} x_i = \frac{a}{b}
$$

代码 ` + '`$M_p$`' + "\n\n```text\n$not_math$\n```\n\n价格 \\$5 与 \\$10。");
  assert.match(html, /<msub>/); assert.match(html, /<msup>/); assert.match(html, /<mfrac>/);
  assert.match(html, /<math[^>]+display="block"/); assert.match(html, /<td><span class="katex"><math/);
  assert.match(html, /<code>\$M_p\$<\/code>/); assert.match(html, /\$not_math\$/);
  assert.match(html, /价格 \$5 与 \$10/);
});

test("invalid math remains readable and cannot share macros, fetch media, add links or inject HTML", () => {
  const malformed = render(String.raw`前文 $\frac{1}{$ 后文 **仍可读**。`);
  assert.match(malformed, /前文/); assert.match(malformed, /后文 <strong>仍可读<\/strong>/);
  assert.match(malformed, /katex-error/);
  const unsafe = render(String.raw`$\href{https://example.com}{链接}$ $\includegraphics{https://example.com/a.png}$ $\htmlStyle{color:red}{x}$ $\text{<img src=x onerror=alert(1)>}$`);
  assert.doesNotMatch(unsafe, /<(?:a|img|script|iframe)\b|\s(?:href|src|onerror)="/i);
  render(String.raw`$\gdef\privateMacro{SECRET} \privateMacro$`);
  assert.doesNotMatch(render(String.raw`$\privateMacro$`), /SECRET/);
  assert.match(render(String.raw`$\def\loop{\loop}\loop$`), /katex-error/);
});
