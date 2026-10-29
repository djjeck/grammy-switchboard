import { type MessageEntity } from "grammy/types";
import { describe, expect, it } from "vitest";
import { inlineLinks } from "../src/entities.js";

const link = (offset: number, length: number, url: string): MessageEntity => ({
  type: "text_link",
  offset,
  length,
  url,
});

describe("inlineLinks", () => {
  it("writes each hidden link inline, in order, whatever order the entities come in", () => {
    const text = "Wan 2.1 [1, 2] and CogVideoX [3]";
    expect(
      inlineLinks(text, [
        link(29, 3, "https://example.com/3"),
        link(8, 6, "https://example.com/1"),
      ]),
    ).toBe("Wan 2.1 [[1, 2]](https://example.com/1) and CogVideoX [[3]](https://example.com/3)");
  });

  it("counts offsets in UTF-16 code units, as Telegram does", () => {
    // 🎬 is two code units, é one.
    expect(inlineLinks("🎬 Pinokio é qui", [link(3, 7, "https://pinokio.co")])).toBe(
      "🎬 [Pinokio](https://pinokio.co) é qui",
    );
  });

  it("leaves bare URLs and every other entity as they are", () => {
    const text = "see https://example.com, *now*";
    expect(
      inlineLinks(text, [
        { type: "url", offset: 4, length: 19 },
        { type: "bold", offset: 25, length: 5 },
      ]),
    ).toBe(text);
  });

  it("returns the text unchanged without entities", () => {
    expect(inlineLinks("plain")).toBe("plain");
    expect(inlineLinks("plain", [])).toBe("plain");
  });

  it("skips a link that overlaps the one before, rather than repeat text", () => {
    expect(
      inlineLinks("one two", [
        link(0, 7, "https://example.com/a"),
        link(4, 3, "https://example.com/b"),
      ]),
    ).toBe("[one two](https://example.com/a)");
  });

  it("handles a link at the very start and the very end", () => {
    expect(inlineLinks("docs", [link(0, 4, "https://example.com")])).toBe(
      "[docs](https://example.com)",
    );
  });
});
