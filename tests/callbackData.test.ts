import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./memoryStore.js";
import {
  buttonCallbackData,
  decodeInline,
  encodeInline,
  resolveCallbackData,
} from "../src/callbackData.js";
import { ButtonTooLongError } from "../src/errors.js";

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
});

describe("encodeInline / decodeInline", () => {
  it("writes the documented format", () => {
    expect(encodeInline({ topic: "ops", ref: "r:1", action: "kill" })).toBe("~3:ops3:r:1kill");
    expect(encodeInline({ topic: "ops", action: "kill" })).toBe("~3:ops-kill");
  });

  it("round-trips values that contain the format's own characters", () => {
    for (const button of [
      { topic: "a:b-c", ref: "-", action: "1:x" },
      { topic: "~", ref: "12:", action: "" },
      { topic: "", ref: "", action: "-" },
      { topic: "t", action: "3:abc" },
    ]) {
      const data = encodeInline(button)!;
      expect(decodeInline(data)).toEqual({ ...button, ref: button.ref ?? null });
    }
  });

  it("tells no ref apart from an empty one", () => {
    expect(decodeInline(encodeInline({ topic: "t", action: "a" })!)?.ref).toBeNull();
    expect(decodeInline(encodeInline({ topic: "t", ref: "", action: "a" })!)?.ref).toBe("");
  });

  it("counts lengths in UTF-8 bytes", () => {
    const button = { topic: "café", ref: "☕:🍰", action: "ок" };
    const data = encodeInline(button)!;

    expect(data).toBe("~5:café8:☕:🍰ок");
    expect(decodeInline(data)).toEqual(button);
  });

  it("fits exactly 64 bytes, not 65, measured in bytes", () => {
    // "~3:ops-" is 7 bytes.
    expect(encodeInline({ topic: "ops", action: "a".repeat(57) })).toBeDefined();
    expect(encodeInline({ topic: "ops", action: "a".repeat(58) })).toBeUndefined();
    // 28 two-byte characters and an "a": 36 characters but 64 bytes; 29 of them are 65.
    expect(encodeInline({ topic: "ops", action: "é".repeat(28) + "a" })).toBeDefined();
    expect(encodeInline({ topic: "ops", action: "é".repeat(29) })).toBeUndefined();
  });

  it("leaves a lone surrogate, which has no UTF-8 form, to the store", () => {
    expect(encodeInline({ topic: "ops", action: "\ud800" })).toBeUndefined();
    expect(encodeInline({ topic: "ops", ref: "\udc00", action: "a" })).toBeUndefined();
  });

  it("rejects corrupt data without throwing", () => {
    for (const data of [
      "3:ops-kill", // no prefix
      "~", // no topic length
      "~x:ops-kill", // not a number
      "~03:ops-kill", // not canonical
      "~9:ops-kill", // runs past the end
      "~3:ops", // no ref
      "~3:ops2:", // ref runs past the end
      "~1:é-a", // a length that cuts a character in half
      "~3:opsx:-a", // ref length not a number
    ]) {
      expect(decodeInline(data)).toBeUndefined();
    }
  });
});

describe("buttonCallbackData / resolveCallbackData", () => {
  const long = { topic: "support", ref: `ticket:<${"x".repeat(60)}>`, action: "ok" };

  it("carries a short button inline, storing nothing", async () => {
    const data = await buttonCallbackData(store, { topic: "ops", ref: "r", action: "kill" });

    expect(data).toBe("~3:ops1:rkill");
    expect(store.buttons.size).toBe(0);
    expect(await resolveCallbackData(store, data)).toEqual({
      topic: "ops",
      ref: "r",
      action: "kill",
    });
  });

  it("decodes an inline button without a store", async () => {
    const data = await buttonCallbackData(undefined, { topic: "ops", action: "kill" });

    expect(await resolveCallbackData(undefined, data)).toEqual({
      topic: "ops",
      ref: null,
      action: "kill",
    });
  });

  it("stores a button that doesn't fit, under the store's id", async () => {
    const data = await buttonCallbackData(store, long);

    expect(data).toBe("b1");
    expect(await resolveCallbackData(store, data)).toEqual(long);
  });

  it("stores a long button with no ref as having a null one", async () => {
    const button = { topic: "support", action: "a".repeat(70) };
    const data = await buttonCallbackData(store, button);

    expect(await resolveCallbackData(store, data)).toEqual({ ...button, ref: null });
  });

  it("throws for a button that doesn't fit when there is no store", async () => {
    await expect(buttonCallbackData(undefined, long)).rejects.toThrow(ButtonTooLongError);
    await expect(buttonCallbackData(undefined, long)).rejects.toMatchObject({
      name: "ButtonTooLongError",
      button: long,
    });
  });

  it("refuses an id from the store that would be read as inline data or cut off", async () => {
    for (const id of ["~1:a-b", "", "x".repeat(65)]) {
      store.saveButton = async () => id;
      await expect(buttonCallbackData(store, long)).rejects.toThrow(/unusable button id/);
    }
  });

  it("returns undefined for corrupt inline data, an unknown id, or any id without a store", async () => {
    expect(await resolveCallbackData(store, "~9:ops")).toBeUndefined();
    expect(await resolveCallbackData(store, "AAAAAAAAAAAAAAAA")).toBeUndefined();
    expect(await resolveCallbackData(undefined, "b1")).toBeUndefined();
  });
});
