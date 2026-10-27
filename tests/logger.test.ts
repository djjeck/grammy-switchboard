import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/logger.js";

describe("silentLogger", () => {
  it("logs nothing at any level", () => {
    expect(silentLogger.info("a", { x: 1 })).toBeUndefined();
    expect(silentLogger.warn("b")).toBeUndefined();
    expect(silentLogger.error("c")).toBeUndefined();
  });
});
