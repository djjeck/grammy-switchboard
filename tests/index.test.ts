import { describe, expect, it, vi } from "vitest";

// The core must never load the native module: only `grammy-switchboard/sqlite` does.
vi.mock("better-sqlite3", () => {
  throw new Error("the core imported better-sqlite3");
});

describe("the package's main entry", () => {
  it("exports the switchboard and its errors without loading better-sqlite3", async () => {
    const entry = await import("../src/index.js");

    expect(Object.keys(entry).sort()).toEqual([
      "ButtonTooLongError",
      "Switchboard",
      "UnknownTopicError",
      "markdownToTelegramHtml",
      "silentLogger",
    ]);
  });
});
