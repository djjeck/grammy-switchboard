import { describe, expect, it } from "vitest";
import { escapeHtml, htmlToPlain } from "../src/html.js";

describe("escapeHtml", () => {
  it("escapes &, < and >, and nothing else", () => {
    expect(escapeHtml(`<b>Tom & "Jerry"</b> ¯\\_(ツ)_/¯ -> &lt;`)).toBe(
      `&lt;b&gt;Tom &amp; "Jerry"&lt;/b&gt; ¯\\_(ツ)_/¯ -&gt; &amp;lt;`,
    );
  });
});

describe("htmlToPlain", () => {
  it("strips tags and unescapes the entities, &amp; last", () => {
    expect(
      htmlToPlain(
        '<u>Title:</u>\n<blockquote><b>a &lt;b&gt; &amp; &quot;c&quot;</b></blockquote>\n<a href="https://x.test/?a=1&amp;b=2">link</a> &amp;lt;',
      ),
    ).toBe('Title:\na <b> & "c"\nlink &lt;');
  });

  it("reads escaped text back as it was", () => {
    const text = "<<ASCII>> & art --> |>";
    expect(htmlToPlain(`<b>${escapeHtml(text)}</b>`)).toBe(text);
  });
});
