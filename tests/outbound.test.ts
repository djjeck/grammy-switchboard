import { InputFile } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, BOT_TOKEN, mockLogger, stubBot } from "./botApi.js";
import { MemoryStore } from "./memoryStore.js";
import { ButtonTooLongError, UnknownTopicError } from "../src/errors.js";
import { Switchboard, type SwitchboardOptions } from "../src/switchboard.js";

const GROUP = -100123;
const OTHER_GROUP = -100456;

const topics = {
  ops: { chatId: GROUP, messageThreadId: 4 },
  support: { chatId: GROUP, messageThreadId: 6 },
  alerts: { chatId: OTHER_GROUP },
};

const photoSizes = (id: string) => [
  { file_id: `${id}-small`, file_unique_id: "s", width: 90, height: 90 },
  { file_id: id, file_unique_id: "l", width: 1280, height: 1280 },
];

let store: MemoryStore;
let logger: ReturnType<typeof mockLogger>;
let telegram: ReturnType<typeof stubBot>["telegram"];

beforeEach(() => {
  store = new MemoryStore();
  logger = mockLogger();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(options: Partial<SwitchboardOptions> = {}) {
  const stub = stubBot({
    sendMessage: { message_id: 101 },
    sendPhoto: { message_id: 102, photo: photoSizes("photo-1") },
    sendMediaGroup: [
      { message_id: 103, photo: photoSizes("album-1") },
      { message_id: 104, photo: photoSizes("album-2") },
    ],
    getFile: { file_id: "f", file_unique_id: "u", file_path: "photos/file_1.jpg" },
  });
  telegram = stub.telegram;
  return new Switchboard({ api: stub.api, topics, store, logger, ...options });
}

function keyboard(payload: Record<string, unknown>): string[][] {
  const markup = payload.reply_markup as {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
  return markup.inline_keyboard.map((row) => row.map((key) => key.callback_data));
}

/** The bytes an InputFile uploads (a buffer's, as is). */
async function bytes(file: InputFile): Promise<Buffer> {
  return Buffer.from((await file.toRaw()) as Uint8Array);
}

describe("send", () => {
  it("sends text to the topic's chat and thread, and records it", async () => {
    const switchboard = setup();
    const result = await switchboard.send({ topic: "ops", text: "hello" });

    expect(result).toEqual({ messageIds: [101], fileIds: [] });
    expect(telegram.sendMessage).toHaveBeenCalledWith({
      chat_id: GROUP,
      text: "hello",
      message_thread_id: 4,
    });
    expect(await store.getMessage(GROUP, 101)).toEqual({
      chatId: GROUP,
      messageId: 101,
      topic: "ops",
      ref: null,
      parentMessageId: null,
    });
  });

  it("sends to a chat with no thread without a thread id", async () => {
    const switchboard = setup();
    await switchboard.send({ topic: "alerts", text: "hello" });

    expect(telegram.sendMessage.mock.calls[0]![0].message_thread_id).toBeUndefined();
  });

  it("replies to a message, recording it as the parent", async () => {
    const switchboard = setup();
    await switchboard.send({ topic: "ops", text: "done", replyTo: 10, ref: "cmd:1" });

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        reply_parameters: { message_id: 10, allow_sending_without_reply: true },
      }),
    );
    expect(await store.getMessage(GROUP, 101)).toEqual({
      chatId: GROUP,
      messageId: 101,
      topic: "ops",
      ref: "cmd:1",
      parentMessageId: 10,
    });
  });

  it("sends a photo by URL or file_id, captioned, returning the file_id Telegram gave it", async () => {
    const switchboard = setup();
    const result = await switchboard.send({
      topic: "ops",
      text: "graph",
      photo: "https://example.com/graph.png",
    });

    expect(result).toEqual({ messageIds: [102], fileIds: ["photo-1"] });
    expect(telegram.sendPhoto).toHaveBeenCalledWith({
      chat_id: GROUP,
      photo: "https://example.com/graph.png",
      caption: "graph",
      message_thread_id: 4,
    });
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("sends a photo with no caption", async () => {
    const switchboard = setup();
    await switchboard.send({ topic: "ops", photo: "photo-1" });

    expect(telegram.sendPhoto.mock.calls[0]![0].caption).toBeUndefined();
  });

  it("uploads one photo given as photos, with its caption and buttons", async () => {
    const switchboard = setup();
    const result = await switchboard.send({
      topic: "ops",
      text: "the rack",
      photos: [new InputFile(Buffer.from("jpeg bytes"), "rack.jpg")],
      buttons: [[{ label: "OK", action: "ok" }]],
    });

    expect(result.messageIds).toEqual([102]);
    const payload = telegram.sendPhoto.mock.calls[0]![0];
    expect(payload.photo).toBeInstanceOf(InputFile);
    expect(await bytes(payload.photo as InputFile)).toEqual(Buffer.from("jpeg bytes"));
    expect(keyboard(payload)).toEqual([["~3:ops-ok"]]);
  });

  it("sends an album captioned on its first photo, recording and pinning it", async () => {
    const switchboard = setup();
    const result = await switchboard.send({
      topic: "ops",
      text: "**before** and after",
      format: "markdown",
      photos: [new InputFile(Buffer.from("a")), "file-id-b"],
      ref: "incident:1",
      replyTo: 9,
      pin: true,
    });

    expect(result).toEqual({ messageIds: [103, 104], fileIds: ["album-1", "album-2"] });
    const payload = telegram.sendMediaGroup.mock.calls[0]![0];
    expect(payload).toMatchObject({
      chat_id: GROUP,
      message_thread_id: 4,
      reply_parameters: { message_id: 9, allow_sending_without_reply: true },
    });
    const media = payload.media as Record<string, unknown>[];
    expect(media[0]).toMatchObject({
      type: "photo",
      caption: "<b>before</b> and after",
      parse_mode: "HTML",
    });
    expect(media[1]).toEqual({ type: "photo", media: "file-id-b" });
    expect((await store.getMessage(GROUP, 104))?.ref).toBe("incident:1");
    expect(telegram.pinChatMessage).toHaveBeenCalledExactlyOnceWith({
      chat_id: GROUP,
      message_id: 103,
      disable_notification: true,
    });
  });

  it("refuses an album with buttons, photo with photos, and a message with nothing", async () => {
    const switchboard = setup();
    await expect(
      switchboard.send({ topic: "ops", photos: ["a", "b"], buttons: [[]] }),
    ).rejects.toThrow(/album can't carry buttons/);
    await expect(switchboard.send({ topic: "ops", photo: "a", photos: ["b"] })).rejects.toThrow(
      /either photo or photos/,
    );
    await expect(switchboard.send({ topic: "ops", photos: [] })).rejects.toThrow(
      /needs text or a photo/,
    );
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("sends Markdown as Telegram HTML, and again as plain text if Telegram rejects it", async () => {
    const switchboard = setup();
    await switchboard.send({ topic: "ops", text: "**done**", format: "markdown" });
    expect(telegram.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "<b>done</b>", parse_mode: "HTML" }),
    );

    telegram.sendMessage
      .mockResolvedValueOnce(new ApiFailure(400, "Bad Request: can't parse entities"))
      .mockResolvedValueOnce({ message_id: 105 });
    const result = await switchboard.send({ topic: "ops", text: "**done**", format: "markdown" });

    expect(result.messageIds).toEqual([105]);
    expect(telegram.sendMessage).toHaveBeenLastCalledWith({
      chat_id: GROUP,
      text: "**done**",
      message_thread_id: 4,
    });
    expect(logger.warn).toHaveBeenCalledWith("formatting rejected, sending plain text", {
      error: "Bad Request: can't parse entities",
    });
  });

  it("sends plain text as is, and doesn't retry other failures", async () => {
    const switchboard = setup();
    await switchboard.send({ topic: "ops", text: "**done**", format: "plain" });
    expect(telegram.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "**done**" }),
    );

    telegram.sendMessage.mockResolvedValueOnce(new ApiFailure(403, "Forbidden: bot was kicked"));
    await expect(
      switchboard.send({ topic: "ops", text: "**x**", format: "markdown" }),
    ).rejects.toThrow(/bot was kicked/);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("carries short buttons inline and stores long ones, under the message's ref", async () => {
    const switchboard = setup();
    const long = "x".repeat(60);
    await switchboard.send({
      topic: "ops",
      text: "approve?",
      ref: "r",
      buttons: [[{ label: "Yes", action: "yes" }], [{ label: "Long", action: long }]],
    });

    expect(keyboard(telegram.sendMessage.mock.calls[0]![0])).toEqual([["~3:ops1:ryes"], ["b1"]]);
    expect(store.buttons.get("b1")).toEqual({ topic: "ops", ref: "r", action: long });
  });

  it("throws before sending a button that doesn't fit, without a store", async () => {
    const switchboard = setup({ store: undefined });
    await expect(
      switchboard.send({
        topic: "ops",
        text: "approve?",
        buttons: [[{ label: "Long", action: "x".repeat(60) }]],
      }),
    ).rejects.toThrow(ButtonTooLongError);
    expect(telegram.sendMessage).not.toHaveBeenCalled();

    // Short ones work without a store, and nothing is recorded.
    const result = await switchboard.send({
      topic: "ops",
      text: "ok?",
      buttons: [[{ label: "OK", action: "ok" }]],
      replyTo: 3,
    });
    expect(result.messageIds).toEqual([101]);
  });

  it("throws UnknownTopicError for a topic it wasn't given", async () => {
    const switchboard = setup();
    await expect(switchboard.send({ topic: "nope", text: "x" })).rejects.toThrow(UnknownTopicError);
    await expect(switchboard.send({ topic: "nope", text: "x" })).rejects.toMatchObject({
      name: "UnknownTopicError",
      topic: "nope",
    });
  });
});

describe("edit", () => {
  async function sent(switchboard: Switchboard, ref?: string): Promise<number> {
    return (await switchboard.send({ topic: "ops", text: "x", ref })).messageIds[0]!;
  }

  it("edits text, as Markdown when asked", async () => {
    const switchboard = setup();
    await switchboard.edit({ topic: "ops", messageId: 5, text: "**new**", format: "markdown" });

    expect(telegram.editMessageText).toHaveBeenCalledWith({
      chat_id: GROUP,
      message_id: 5,
      text: "<b>new</b>",
      parse_mode: "HTML",
    });
  });

  it("replaces a photo, with or without a new caption", async () => {
    const switchboard = setup();
    await switchboard.edit({ topic: "ops", messageId: 5, photo: "new-photo" });
    await switchboard.edit({
      topic: "ops",
      messageId: 5,
      photo: "new-photo",
      text: "*caption*",
      format: "markdown",
    });

    expect(telegram.editMessageMedia.mock.calls[0]![0]).toMatchObject({
      media: { type: "photo", media: "new-photo" },
    });
    expect(telegram.editMessageMedia.mock.calls[0]![0].media).not.toHaveProperty("caption", "");
    expect(telegram.editMessageMedia.mock.calls[1]![0]).toMatchObject({
      media: { caption: "<i>caption</i>", parse_mode: "HTML" },
    });
    expect(telegram.editMessageText).not.toHaveBeenCalled();
  });

  it("edits only the buttons, keeping the ref the message was sent with", async () => {
    const switchboard = setup();
    const messageId = await sent(switchboard, "incident:1");
    await switchboard.edit({
      topic: "ops",
      messageId,
      buttons: [[{ label: "Ack", action: "ack" }]],
    });

    expect(keyboard(telegram.editMessageReplyMarkup.mock.calls[0]![0])).toEqual([
      ["~3:ops10:incident:1ack"],
    ]);
  });

  it("removes the buttons with an empty list", async () => {
    const switchboard = setup();
    await switchboard.edit({ topic: "ops", messageId: 5, buttons: [] });

    expect(telegram.editMessageReplyMarkup).toHaveBeenCalledWith({
      chat_id: GROUP,
      message_id: 5,
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("takes an explicit ref for new buttons and records it as the message's", async () => {
    const switchboard = setup();
    const messageId = await sent(switchboard, "incident:1");
    await switchboard.edit({
      topic: "ops",
      messageId,
      text: "y",
      ref: "incident:2",
      buttons: [[{ label: "Ack", action: "ack" }]],
    });

    expect(keyboard(telegram.editMessageText.mock.calls[0]![0])).toEqual([
      ["~3:ops10:incident:2ack"],
    ]);
    expect((await store.getMessage(GROUP, messageId))?.ref).toBe("incident:2");
  });

  it("leaves new buttons ref-less on a message sent without one, or unknown, or without a store", async () => {
    const switchboard = setup();
    const messageId = await sent(switchboard);
    const buttons = [[{ label: "Ack", action: "ack" }]];
    await switchboard.edit({ topic: "ops", messageId, buttons });
    await switchboard.edit({ topic: "ops", messageId: 999, buttons, ref: "r" });
    await setup({ store: undefined }).edit({ topic: "ops", messageId: 5, buttons });

    expect(keyboard(telegram.editMessageReplyMarkup.mock.calls[0]![0])).toEqual([["~3:ops-ack"]]);
    expect(await store.getMessage(GROUP, 999)).toBeUndefined();
  });

  it("does nothing with nothing to change, and unpins when asked", async () => {
    const switchboard = setup();
    await switchboard.edit({ topic: "ops", messageId: 5 });
    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(telegram.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(telegram.unpinChatMessage).not.toHaveBeenCalled();

    await switchboard.edit({ topic: "ops", messageId: 5, unpin: true });
    expect(telegram.unpinChatMessage).toHaveBeenCalledWith({ chat_id: GROUP, message_id: 5 });
  });

  it("throws UnknownTopicError for a topic it wasn't given", async () => {
    await expect(setup().edit({ topic: "nope", messageId: 1, text: "x" })).rejects.toThrow(
      UnknownTopicError,
    );
  });
});

describe("delete and typing", () => {
  it("deletes a message in the topic's chat", async () => {
    const switchboard = setup();
    await switchboard.delete({ topic: "ops", messageId: 5 });

    expect(telegram.deleteMessage).toHaveBeenCalledWith({ chat_id: GROUP, message_id: 5 });
    await expect(switchboard.delete({ topic: "nope", messageId: 5 })).rejects.toThrow(
      UnknownTopicError,
    );
  });

  it("shows typing in the topic's chat and thread", async () => {
    const switchboard = setup();
    await switchboard.typing({ topic: "ops" });

    expect(telegram.sendChatAction).toHaveBeenCalledWith({
      chat_id: GROUP,
      action: "typing",
      message_thread_id: 4,
    });
    await expect(switchboard.typing({ topic: "nope" })).rejects.toThrow(UnknownTopicError);
  });
});

describe("command menus", () => {
  const commands = {
    ops: [
      { command: "status", description: "Show the status" },
      { command: "help", description: "Help for ops" },
    ],
    support: [{ command: "help", description: "Help for support" }],
  };

  it("merges a chat's topics' commands, keeping the first description", () => {
    const switchboard = setup({ commands });

    expect(switchboard.commandMenu(GROUP)).toEqual([
      { command: "status", description: "Show the status" },
      { command: "help", description: "Help for ops" },
    ]);
    expect(switchboard.commandMenu(OTHER_GROUP)).toEqual([]);
  });

  it("replaces a topic's commands, keeping a copy", () => {
    const switchboard = setup({ commands });
    const replacement = [{ command: "deploy", description: "Deploy" }];
    switchboard.setCommands("ops", replacement);
    replacement[0]!.command = "changed";

    expect(switchboard.getCommands("ops")).toEqual([{ command: "deploy", description: "Deploy" }]);
    expect(switchboard.getCommands("alerts")).toEqual([]);
    expect(() => switchboard.setCommands("nope", [])).toThrow(UnknownTopicError);
    expect(() => switchboard.getCommands("nope")).toThrow(UnknownTopicError);
    expect(() => setup({ commands: { nope: [] } })).toThrow(UnknownTopicError);
  });

  it("sets one topic's chat menu in chat scope, or clears it, and throws a failure", async () => {
    const switchboard = setup({ commands });
    await switchboard.registerCommandMenu("support");
    await switchboard.registerCommandMenu("alerts");

    expect(telegram.setMyCommands).toHaveBeenCalledWith({
      commands: commands.ops,
      scope: { type: "chat", chat_id: GROUP },
    });
    expect(telegram.deleteMyCommands).toHaveBeenCalledWith({
      scope: { type: "chat", chat_id: OTHER_GROUP },
    });
    expect(logger.info).toHaveBeenCalledWith("registered command menu", {
      chatId: GROUP,
      commands: 2,
    });

    telegram.setMyCommands.mockResolvedValueOnce(
      new ApiFailure(400, "Bad Request: chat not found"),
    );
    await expect(switchboard.registerCommandMenu("ops")).rejects.toThrow(/chat not found/);
    await expect(switchboard.registerCommandMenu("nope")).rejects.toThrow(UnknownTopicError);
  });

  it("sets every chat's menu once, logging a chat that fails and going on", async () => {
    const switchboard = setup({ commands });
    telegram.setMyCommands.mockResolvedValueOnce(
      new ApiFailure(400, "Bad Request: chat not found"),
    );
    await switchboard.registerCommandMenus();

    expect(telegram.setMyCommands).toHaveBeenCalledOnce();
    expect(telegram.deleteMyCommands).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("failed to register command menu", {
      chatId: GROUP,
      error: expect.stringContaining("chat not found"),
    });
  });
});

describe("fetchFile", () => {
  it("downloads a file's bytes through the Bot API", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    const switchboard = setup();

    const file = await switchboard.fetchFile("f");

    expect(file).toEqual({ data: new Uint8Array([1, 2, 3]), filePath: "photos/file_1.jpg" });
    expect(telegram.getFile).toHaveBeenCalledWith({ file_id: "f" });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/photos/file_1.jpg`,
    );
  });

  it("downloads from the API root it was given", async () => {
    const fetchMock = vi.fn(async () => new Response("x"));
    vi.stubGlobal("fetch", fetchMock);
    await setup({ apiRoot: "http://bot-api.local:8081" }).fetchFile("f");

    expect(fetchMock).toHaveBeenCalledWith(
      `http://bot-api.local:8081/file/bot${BOT_TOKEN}/photos/file_1.jpg`,
    );
  });

  it("fails without the token in the error", async () => {
    const switchboard = setup();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 404 })),
    );
    await expect(switchboard.fetchFile("f")).rejects.toThrow("Failed to download file: HTTP 404");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new TypeError(`fetch failed for ${url}`);
      }),
    );
    const error = (await switchboard.fetchFile("f").catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/^Failed to download file: TypeError: fetch failed/);
    expect(error.message).not.toContain(BOT_TOKEN);
    expect(error.message).toContain("bot<token>");
  });

  it("fails for a file Telegram gives no path for, or doesn't know", async () => {
    const switchboard = setup();
    telegram.getFile.mockResolvedValueOnce({ file_id: "f", file_unique_id: "u" });
    await expect(switchboard.fetchFile("f")).rejects.toThrow(/no download path/);

    telegram.getFile.mockResolvedValueOnce(new ApiFailure(400, "Bad Request: invalid file_id"));
    await expect(switchboard.fetchFile("f")).rejects.toThrow(/invalid file_id/);
  });
});
