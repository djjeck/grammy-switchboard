import { type Context } from "grammy";
import { type Update } from "grammy/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, mockLogger, stubBot } from "./botApi.js";
import { MemoryStore } from "./memoryStore.js";
import { type InboundEvent } from "../src/events.js";
import { Switchboard, type SwitchboardOptions } from "../src/switchboard.js";

const GROUP = -100123;
const OTHER_GROUP = -100456;

const topics = {
  ops: { chatId: GROUP, messageThreadId: 4 },
  // Same chat, no commands registered: a command typed here is a plain message.
  support: { chatId: GROUP, messageThreadId: 6 },
  // Another chat, which numbers its messages independently of the first, with no forum topics.
  alerts: { chatId: OTHER_GROUP },
};

let store: MemoryStore;
let events: InboundEvent[];
let logger: ReturnType<typeof mockLogger>;
let telegram: ReturnType<typeof stubBot>["telegram"];
let after: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  store = new MemoryStore();
  events = [];
  logger = mockLogger();
});

/**
 * A bot with a switchboard (messages on and a store, unless overridden) whose handlers collect
 * every event, followed by middleware that records what the switchboard passed on.
 */
function setup(options: Partial<SwitchboardOptions> = {}, handle = true) {
  const stub = stubBot();
  telegram = stub.telegram;
  const switchboard = new Switchboard({
    api: stub.api,
    topics,
    commands: { ops: [{ command: "status", description: "Show the status" }] },
    store,
    logger,
    messages: true,
    ...options,
  });
  if (handle) {
    const collect = (event: InboundEvent) => {
      events.push(event);
    };
    switchboard
      .on("command", collect)
      .on("message", collect)
      .on("reply", collect)
      .on("button", collect)
      .on("photo", collect);
  }
  stub.bot.use(switchboard);
  after = vi.fn<() => void>();
  stub.bot.use(after);
  return { bot: stub.bot, switchboard };
}

let updateId = 0;

function textUpdate(
  text: string,
  fields: Record<string, unknown> = {},
  chat = { id: GROUP, type: "supergroup" },
): Update {
  return {
    update_id: ++updateId,
    message: {
      message_id: 10,
      date: 0,
      chat,
      message_thread_id: 4,
      is_topic_message: true,
      from: { id: 7, is_bot: false, first_name: "Ada" },
      text,
      ...fields,
    },
  } as unknown as Update;
}

function commandUpdate(text: string, fields: Record<string, unknown> = {}): Update {
  const length = text.split(" ")[0]!.length;
  return textUpdate(text, {
    entities: [{ type: "bot_command", offset: 0, length }],
    ...fields,
  });
}

function photoUpdate(fields: Record<string, unknown> = {}): Update {
  return {
    update_id: ++updateId,
    message: {
      message_id: 20,
      date: 0,
      chat: { id: GROUP, type: "supergroup" },
      message_thread_id: 4,
      is_topic_message: true,
      from: { id: 7, is_bot: false, first_name: "Ada" },
      photo: [
        { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
        { file_id: "large", file_unique_id: "l", width: 1280, height: 1280 },
      ],
      ...fields,
    },
  } as unknown as Update;
}

function buttonUpdate(data: string | undefined, message?: Record<string, unknown>): Update {
  return {
    update_id: ++updateId,
    callback_query: {
      id: `cbq${updateId}`,
      from: { id: 7, is_bot: false, first_name: "Ada", last_name: "Lovelace" },
      chat_instance: "x",
      ...(data === undefined ? { game_short_name: "game" } : { data }),
      ...(message === undefined
        ? {}
        : { message: { date: 0, chat: { id: GROUP, type: "supergroup" }, ...message } }),
    },
  } as unknown as Update;
}

const parentOf = (id: number) => ({
  reply_to_message: { message_id: id, date: 0, chat: { id: GROUP, type: "supergroup" } },
});

describe("button presses", () => {
  it("delivers an inline button, answering the press first", async () => {
    const { bot } = setup();
    await bot.handleUpdate(buttonUpdate("~3:ops4:r:42ack", { message_id: 42 }));

    expect(events).toEqual([
      {
        type: "button",
        topic: "ops",
        ref: "r:42",
        action: "ack",
        messageId: 42,
        from: { id: "7", name: "Ada Lovelace" },
      },
    ]);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledOnce();
    expect(after).not.toHaveBeenCalled();
  });

  it("answers before the handler runs, so the spinner stops however long it takes", async () => {
    const { bot, switchboard } = setup({}, false);
    const order: string[] = [];
    telegram.answerCallbackQuery.mockImplementation(async () => {
      order.push("answered");
      return true;
    });
    switchboard.on("button", () => {
      order.push("handled");
    });
    await bot.handleUpdate(buttonUpdate("~3:ops-ack"));

    expect(order).toEqual(["answered", "handled"]);
  });

  it("delivers a stored button, and one on a message the bot can no longer see", async () => {
    const id = await store.saveButton({ topic: "ops", ref: "long-ref", action: "approve" });
    const { bot } = setup();
    await bot.handleUpdate(buttonUpdate(id));

    expect(events).toEqual([
      {
        type: "button",
        topic: "ops",
        ref: "long-ref",
        action: "approve",
        messageId: undefined,
        from: { id: "7", name: "Ada Lovelace" },
      },
    ]);
  });

  it("still delivers a press Telegram refuses to answer (too old)", async () => {
    const { bot } = setup();
    telegram.answerCallbackQuery.mockResolvedValue(new ApiFailure(400, "query is too old"));
    await bot.handleUpdate(buttonUpdate("~3:ops-ack"));

    expect(events).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith("failed to answer button press", expect.any(Object));
  });

  it("passes on, unanswered, a button that isn't the switchboard's", async () => {
    const { bot } = setup();
    // Another plugin's data, an id the store doesn't have, and a game's button with no data.
    for (const data of ["menu:open", "AAAAAAAAAAAAAAAA", undefined]) {
      await bot.handleUpdate(buttonUpdate(data));
    }

    expect(events).toEqual([]);
    expect(after).toHaveBeenCalledTimes(3);
    expect(telegram.answerCallbackQuery).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("passes on corrupt inline data, logging it", async () => {
    const { bot } = setup();
    await bot.handleUpdate(buttonUpdate("~99:ops-ack"));

    expect(after).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("unrecognised button data", {
      callbackData: "~99:ops-ack",
    });
  });

  it("passes on a button for a topic that isn't registered", async () => {
    const id = await store.saveButton({ topic: "gone", ref: null, action: "ack" });
    const { bot } = setup();
    await bot.handleUpdate(buttonUpdate("~4:gone-ack"));
    await bot.handleUpdate(buttonUpdate(id));

    expect(events).toEqual([]);
    expect(after).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("button for a topic not registered", {
      topic: "gone",
    });
  });

  it("resolves inline buttons without a store, and passes on anything else", async () => {
    const { bot } = setup({ store: undefined });
    await bot.handleUpdate(buttonUpdate("~3:ops-ack"));
    await bot.handleUpdate(buttonUpdate("b1"));

    expect(events).toMatchObject([{ type: "button", topic: "ops", action: "ack" }]);
    expect(after).toHaveBeenCalledOnce();
  });

  it("passes on, unanswered, its own button when nothing handles buttons", async () => {
    const { bot } = setup({}, false);
    await bot.handleUpdate(buttonUpdate("~3:ops-ack"));

    expect(after).toHaveBeenCalledOnce();
    expect(telegram.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it("delivers buttons with messages off", async () => {
    const { bot } = setup({ messages: false });
    await bot.handleUpdate(buttonUpdate("~3:ops-ack"));

    expect(events).toHaveLength(1);
  });
});

describe("commands", () => {
  it("delivers a registered command, bare or addressed to this bot", async () => {
    const { bot } = setup();
    await bot.handleUpdate(commandUpdate("/status  db  replica "));
    await bot.handleUpdate(commandUpdate("/STATUS@testbot"));

    expect(events).toEqual([
      {
        type: "command",
        topic: "ops",
        command: "status",
        args: "db  replica",
        messageId: 10,
        from: { id: "7", name: "Ada" },
      },
      {
        type: "command",
        topic: "ops",
        command: "status",
        args: "",
        messageId: 10,
        from: { id: "7", name: "Ada" },
      },
    ]);
    expect(after).not.toHaveBeenCalled();
  });

  it("matches a command registered in another case", async () => {
    const { bot } = setup({ commands: { ops: [{ command: "Status", description: "d" }] } });
    await bot.handleUpdate(commandUpdate("/status"));

    expect(events).toMatchObject([{ type: "command", command: "status" }]);
  });

  it("delivers a command that replies to a stored message as a command, not a link", async () => {
    await store.recordMessage({
      chatId: GROUP,
      messageId: 5,
      topic: "ops",
      ref: "incident:1",
      parentMessageId: null,
    });
    const { bot } = setup();
    await bot.handleUpdate(commandUpdate("/status", parentOf(5)));

    expect(events).toMatchObject([{ type: "command", command: "status" }]);
    expect(store.messages.size).toBe(1);
  });

  it("delivers anything else that looks like a command as a message, with messages on", async () => {
    const { bot } = setup();
    // Unregistered; registered only in another topic; addressed to another bot; not at the
    // start; and a first entity that isn't a command.
    await bot.handleUpdate(commandUpdate("/unknown"));
    await bot.handleUpdate(commandUpdate("/status", { message_thread_id: 6 }));
    await bot.handleUpdate(commandUpdate("/status@OtherBot"));
    await bot.handleUpdate(
      textUpdate("see /status", { entities: [{ type: "bot_command", offset: 4, length: 7 }] }),
    );
    await bot.handleUpdate(
      textUpdate("/status", { entities: [{ type: "bold", offset: 0, length: 7 }] }),
    );

    expect(events.map((event) => [event.type, event.topic])).toEqual([
      ["message", "ops"],
      ["message", "support"],
      ["message", "ops"],
      ["message", "ops"],
      ["message", "ops"],
    ]);
  });

  it("passes on unregistered commands with messages off, and registered ones nobody handles", async () => {
    const off = setup({ messages: false });
    await off.bot.handleUpdate(commandUpdate("/unknown"));
    await off.bot.handleUpdate(commandUpdate("/status"));
    expect(events).toMatchObject([{ type: "command", command: "status" }]);
    expect(after).toHaveBeenCalledOnce();

    const unhandled = setup({}, false);
    await unhandled.bot.handleUpdate(commandUpdate("/status"));
    expect(after).toHaveBeenCalledOnce();
  });

  it("follows commands replaced at runtime", async () => {
    const { bot, switchboard } = setup();
    switchboard.setCommands("ops", [{ command: "deploy", description: "Deploy" }]);
    await bot.handleUpdate(commandUpdate("/status"));
    await bot.handleUpdate(commandUpdate("/deploy now"));

    expect(events).toMatchObject([
      { type: "message", text: "/status" },
      { type: "command", command: "deploy", args: "now" },
    ]);
  });
});

describe("messages and replies", () => {
  it("delivers a plain message in a topic", async () => {
    const { bot } = setup();
    await bot.handleUpdate(textUpdate("hello there"));

    expect(events).toEqual([
      {
        type: "message",
        topic: "ops",
        text: "hello there",
        messageId: 10,
        from: { id: "7", name: "Ada" },
      },
    ]);
    expect(store.messages.size).toBe(0);
  });

  it("carries a message's and a reply's entities, hidden links included", async () => {
    await store.recordMessage({
      chatId: GROUP,
      messageId: 5,
      topic: "ops",
      ref: "incident:1",
      parentMessageId: null,
    });
    const entities = [{ type: "text_link", offset: 4, length: 4, url: "https://example.com" }];
    const { bot } = setup();
    await bot.handleUpdate(textUpdate("see docs", { entities }));
    await bot.handleUpdate(textUpdate("see docs", { entities, ...parentOf(5) }));

    expect(events).toEqual([
      {
        type: "message",
        topic: "ops",
        text: "see docs",
        entities,
        messageId: 10,
        from: { id: "7", name: "Ada" },
      },
      {
        type: "reply",
        topic: "ops",
        ref: "incident:1",
        text: "see docs",
        entities,
        messageId: 10,
        from: { id: "7", name: "Ada" },
      },
    ]);
  });

  it("passes on messages, replies and photos with messages off, storing nothing", async () => {
    await store.recordMessage({
      chatId: GROUP,
      messageId: 5,
      topic: "ops",
      ref: "r",
      parentMessageId: null,
    });
    const { bot } = setup({ messages: false });
    await bot.handleUpdate(textUpdate("hello"));
    await bot.handleUpdate(textUpdate("reply", parentOf(5)));
    await bot.handleUpdate(photoUpdate(parentOf(5)));

    expect(events).toEqual([]);
    expect(after).toHaveBeenCalledTimes(3);
    expect(store.messages.size).toBe(1);
  });

  it("passes on anything from a chat or thread with no topic", async () => {
    const { bot } = setup();
    await bot.handleUpdate(textUpdate("hello", { message_thread_id: 999 }));
    await bot.handleUpdate(photoUpdate({ message_thread_id: 999 }));
    await bot.handleUpdate(textUpdate("hello", {}, { id: -100999, type: "supergroup" }));
    await bot.handleUpdate(commandUpdate("/status", { message_thread_id: 999 }));

    expect(events).toEqual([]);
    expect(after).toHaveBeenCalledTimes(4);
  });

  it("passes on updates the switchboard doesn't handle at all", async () => {
    const { bot } = setup();
    await bot.handleUpdate({
      update_id: ++updateId,
      edited_message: (textUpdate("edited") as { message: unknown }).message,
    } as unknown as Update);

    expect(after).toHaveBeenCalledOnce();
  });

  it("maps a reply in a group without forum topics to the chat's topic", async () => {
    const { bot } = setup();
    // Telegram puts the replied-to message's id in message_thread_id, without is_topic_message.
    await bot.handleUpdate(
      textUpdate(
        "reply",
        { message_thread_id: 77, is_topic_message: undefined },
        { id: OTHER_GROUP, type: "supergroup" },
      ),
    );
    // A forum topic with no switchboard topic doesn't fall back to the chat's General.
    await bot.handleUpdate(
      textUpdate("x", { message_thread_id: 77 }, { id: OTHER_GROUP, type: "supergroup" }),
    );

    expect(events).toMatchObject([{ type: "message", topic: "alerts", text: "reply" }]);
    expect(after).toHaveBeenCalledOnce();
  });

  it("delivers a reply to a stored message with its ref, recording the link", async () => {
    await store.recordMessage({
      chatId: GROUP,
      messageId: 5,
      topic: "ops",
      ref: "incident:1",
      parentMessageId: null,
    });
    const { bot } = setup();
    await bot.handleUpdate(textUpdate("on it", parentOf(5)));

    expect(events).toEqual([
      {
        type: "reply",
        topic: "ops",
        ref: "incident:1",
        text: "on it",
        messageId: 10,
        from: { id: "7", name: "Ada" },
      },
    ]);
    expect(await store.getMessage(GROUP, 10)).toEqual({
      chatId: GROUP,
      messageId: 10,
      topic: "ops",
      ref: null,
      parentMessageId: 5,
    });
  });

  it("keeps the ref through a chain of replies, including through a photo", async () => {
    await store.recordMessage({
      chatId: GROUP,
      messageId: 5,
      topic: "ops",
      ref: "incident:1",
      parentMessageId: null,
    });
    const { bot } = setup();
    await bot.handleUpdate(textUpdate("first", { message_id: 6, ...parentOf(5) }));
    await bot.handleUpdate(photoUpdate({ message_id: 7, ...parentOf(6) }));
    await bot.handleUpdate(textUpdate("third", { message_id: 8, ...parentOf(7) }));

    expect(events.map((event) => [event.type, "ref" in event ? event.ref : undefined])).toEqual([
      ["reply", "incident:1"],
      ["photo", "incident:1"],
      ["reply", "incident:1"],
    ]);
  });

  it("delivers a reply to an unknown message (or the topic's creation message) as a message", async () => {
    const { bot } = setup();
    await bot.handleUpdate(textUpdate("hm", parentOf(4)));

    expect(events).toMatchObject([{ type: "message", text: "hm" }]);
    expect(store.messages.size).toBe(0);
  });

  it("delivers a reply as a plain message without a store", async () => {
    const { bot } = setup({ store: undefined });
    await bot.handleUpdate(textUpdate("on it", parentOf(5)));

    expect(events).toMatchObject([{ type: "message", text: "on it" }]);
  });

  it("records the link before the handler runs, so a failing handler doesn't break the chain", async () => {
    await store.recordMessage({
      chatId: GROUP,
      messageId: 5,
      topic: "ops",
      ref: "incident:1",
      parentMessageId: null,
    });
    const { bot, switchboard } = setup({}, false);
    const failure = new Error("handler failed");
    switchboard.on("reply", () => {
      throw failure;
    });

    // The error reaches grammY, which hands it to bot.catch (here: handleUpdate rejects).
    await expect(bot.handleUpdate(textUpdate("on it", parentOf(5)))).rejects.toMatchObject({
      error: failure,
    });
    expect(await store.getMessage(GROUP, 10)).toMatchObject({ parentMessageId: 5 });
  });

  it("passes on a message or a reply whose type nobody handles", async () => {
    await store.recordMessage({
      chatId: GROUP,
      messageId: 5,
      topic: "ops",
      ref: "r",
      parentMessageId: null,
    });
    const { bot, switchboard } = setup({}, false);
    const replies = vi.fn();
    switchboard.on("reply", replies);
    await bot.handleUpdate(textUpdate("plain"));
    expect(after).toHaveBeenCalledOnce();

    const messages = setup({}, false);
    messages.switchboard.on("message", replies);
    await messages.bot.handleUpdate(textUpdate("reply", parentOf(5)));
    expect(after).toHaveBeenCalledOnce();
    expect(replies).not.toHaveBeenCalled();
  });

  it("runs every handler of a type in order, with the grammY context", async () => {
    const { bot, switchboard } = setup({}, false);
    const seen: string[] = [];
    switchboard
      .on("message", (event, ctx: Context) => {
        seen.push(`first ${event.text} ${ctx.update.update_id}`);
      })
      .on("message", async () => {
        seen.push("second");
      });
    await bot.handleUpdate(textUpdate("hi"));

    expect(seen).toEqual([`first hi ${updateId}`, "second"]);
  });
});

describe("defaults", () => {
  it("delivers only commands and buttons, with no logger, store or commands given", async () => {
    const stub = stubBot();
    const switchboard = new Switchboard({ api: stub.api, topics });
    const seen = vi.fn();
    switchboard.on("message", seen).on("button", seen).on("command", seen);
    stub.bot.use(switchboard);
    const next = vi.fn<() => void>();
    stub.bot.use(next);

    await stub.bot.handleUpdate(textUpdate("hello"));
    await stub.bot.handleUpdate(commandUpdate("/status"));
    await stub.bot.handleUpdate(buttonUpdate("~99:corrupt"));
    await stub.bot.handleUpdate(buttonUpdate("~3:ops-ack"));

    expect(seen).toHaveBeenCalledOnce();
    expect(seen.mock.calls[0]![0]).toMatchObject({ type: "button", action: "ack" });
    expect(next).toHaveBeenCalledTimes(3);
  });
});

describe("photos", () => {
  it("delivers the largest size's file id, with caption and album id", async () => {
    const { bot } = setup();
    await bot.handleUpdate(photoUpdate({ caption: "the rack", media_group_id: "album1" }));

    expect(events).toEqual([
      {
        type: "photo",
        topic: "ops",
        ref: null,
        fileId: "large",
        caption: "the rack",
        messageId: 20,
        mediaGroupId: "album1",
        from: { id: "7", name: "Ada" },
      },
    ]);
  });

  it("carries the caption's entities", async () => {
    const captionEntities = [
      { type: "text_link", offset: 4, length: 4, url: "https://example.com" },
    ];
    const { bot } = setup();
    await bot.handleUpdate(photoUpdate({ caption: "the rack", caption_entities: captionEntities }));

    expect(events).toEqual([
      {
        type: "photo",
        topic: "ops",
        ref: null,
        fileId: "large",
        caption: "the rack",
        captionEntities,
        messageId: 20,
        from: { id: "7", name: "Ada" },
      },
    ]);
  });

  it("passes on a photo with no sizes, or with nobody handling photos", async () => {
    const { bot } = setup();
    await bot.handleUpdate(photoUpdate({ photo: [] }));
    expect(after).toHaveBeenCalledOnce();

    const unhandled = setup({}, false);
    await unhandled.bot.handleUpdate(photoUpdate());
    expect(after).toHaveBeenCalledOnce();
  });
});

describe("sender", () => {
  it("joins first and last name, else the username, else the id, and leaves out no sender", async () => {
    const { bot } = setup();
    await bot.handleUpdate(
      textUpdate("a", { from: { id: 1, is_bot: false, first_name: "", username: "ada" } }),
    );
    await bot.handleUpdate(textUpdate("b", { from: { id: 2, is_bot: false, first_name: "" } }));
    await bot.handleUpdate(textUpdate("c", { from: undefined }));

    expect(events.map((event) => event.from)).toEqual([
      { id: "1", name: "ada" },
      { id: "2", name: "2" },
      undefined,
    ]);
  });
});
