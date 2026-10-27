import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./memoryStore.js";
import { recordReply, resolveLineage, type StoredMessage } from "../src/store.js";

const CHAT = -100123;
const OTHER_CHAT = -100456;

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
});

function message(
  messageId: number,
  ref: string | null,
  parentMessageId: number | null,
  chatId = CHAT,
): StoredMessage {
  return { chatId, messageId, topic: "ops", ref, parentMessageId };
}

describe("resolveLineage", () => {
  it("returns undefined for an unknown message", async () => {
    expect(await resolveLineage(store, CHAT, 1)).toBeUndefined();
  });

  it("resolves a message's own ref", async () => {
    await store.recordMessage(message(1, "incident:1", null));

    expect(await resolveLineage(store, CHAT, 1)).toEqual({ topic: "ops", ref: "incident:1" });
  });

  it("resolves an arbitrarily deep chain's ref from its root", async () => {
    await store.recordMessage(message(1, "incident:1", null));
    for (let id = 2; id <= 20; id++) {
      await store.recordMessage(message(id, null, id - 1));
    }

    expect(await resolveLineage(store, CHAT, 20)).toEqual({ topic: "ops", ref: "incident:1" });
  });

  it("stops at the first ref up the chain, so a message's own ref wins", async () => {
    await store.recordMessage(message(1, "incident:1", null));
    await store.recordMessage(message(2, "incident:2", 1));
    await store.recordMessage(message(3, null, 2));

    expect(await resolveLineage(store, CHAT, 3)).toEqual({ topic: "ops", ref: "incident:2" });
  });

  it("walks within its own chat, never into another chat's same ids", async () => {
    await store.recordMessage(message(1, "theirs", null, OTHER_CHAT));
    await store.recordMessage(message(1, "ours", null));
    await store.recordMessage(message(2, null, 1));

    expect(await resolveLineage(store, CHAT, 2)).toEqual({ topic: "ops", ref: "ours" });
  });

  it("returns a null ref when the chain ends without one, or at a missing parent", async () => {
    await store.recordMessage(message(1, null, null));
    await store.recordMessage(message(3, null, 2));

    expect(await resolveLineage(store, CHAT, 1)).toEqual({ topic: "ops", ref: null });
    expect(await resolveLineage(store, CHAT, 3)).toEqual({ topic: "ops", ref: null });
  });

  it("does not hang on a cycle", async () => {
    await store.recordMessage(message(1, null, 2));
    await store.recordMessage(message(2, null, 1));

    expect(await resolveLineage(store, CHAT, 1)).toEqual({ topic: "ops", ref: null });
  });
});

describe("recordReply", () => {
  it("records a reply to a stored message under it, with no ref of its own", async () => {
    await store.recordMessage(message(1, "incident:1", null));

    const lineage = await recordReply(store, {
      chatId: CHAT,
      messageId: 2,
      topic: "ops",
      parentMessageId: 1,
    });

    expect(lineage).toEqual({ topic: "ops", ref: "incident:1" });
    expect(await store.getMessage(CHAT, 2)).toEqual(message(2, null, 1));
  });

  it("records nothing for a reply to a message that isn't stored", async () => {
    const lineage = await recordReply(store, {
      chatId: CHAT,
      messageId: 2,
      topic: "ops",
      parentMessageId: 1,
    });

    expect(lineage).toBeUndefined();
    expect(store.messages.size).toBe(0);
  });
});
