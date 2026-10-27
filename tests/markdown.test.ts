import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "../src/markdown.js";

describe("markdownToTelegramHtml", () => {
  it("converts bold, italic, strikethrough and links", () => {
    expect(
      markdownToTelegramHtml(
        "**Done** and __done__, *maybe* _later_, ~~not~~, see [docs](https://example.com/a_b*c)",
      ),
    ).toBe(
      '<b>Done</b> and <b>done</b>, <i>maybe</i> <i>later</i>, <s>not</s>, see <a href="https://example.com/a_b*c">docs</a>',
    );
  });

  it("escapes HTML, leaving it as text", () => {
    expect(markdownToTelegramHtml("a < b && c > d, <b>not bold</b>")).toBe(
      "a &lt; b &amp;&amp; c &gt; d, &lt;b&gt;not bold&lt;/b&gt;",
    );
  });

  it("formats nothing inside code, and escapes it", () => {
    expect(markdownToTelegramHtml("run `a **b** <c>` now")).toBe(
      "run <code>a **b** &lt;c&gt;</code> now",
    );
    expect(markdownToTelegramHtml("```ts\nconst x = a < b && **c**;\n```\nafter **it**")).toBe(
      "<pre>const x = a &lt; b &amp;&amp; **c**;</pre>\nafter <b>it</b>",
    );
  });

  it("leaves an unclosed code fence as text", () => {
    expect(markdownToTelegramHtml("```\nno end")).toBe("```\nno end");
  });

  it("leaves lone markers, snake_case and arithmetic alone", () => {
    expect(markdownToTelegramHtml("snake_case_name, 2*3*4, a * b, 5 ** 2, ** x **")).toBe(
      "snake_case_name, 2*3*4, a * b, 5 ** 2, ** x **",
    );
  });

  it("turns headings into bold lines and list items into bullets", () => {
    expect(markdownToTelegramHtml("## Status\n- **Backup** — 15 min\n  * nested\n+ plus")).toBe(
      "<b>Status</b>\n• <b>Backup</b> — 15 min\n  • nested\n• plus",
    );
  });
});
