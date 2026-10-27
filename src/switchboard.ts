import {
  type Api,
  Composer,
  type Context,
  type InputFile,
  type MiddlewareFn,
  type MiddlewareObj,
} from "grammy";
import {
  type BotCommand,
  type InlineKeyboardMarkup,
  type Message,
  type MessageEntity,
  type ReplyParameters,
  type User,
} from "grammy/types";
import { buttonCallbackData, INLINE_PREFIX, resolveCallbackData } from "./callbackData.js";
import { UnknownTopicError } from "./errors.js";
import {
  type EventHandler,
  type EventOf,
  type EventType,
  type InboundEvent,
  type Sender,
} from "./events.js";
import { type TextFormat, withFormat } from "./format.js";
import { type Logger, silentLogger } from "./logger.js";
import { type Lineage, recordReply, type SwitchboardStore } from "./store.js";

/**
 * Where a topic is: a chat, and the forum topic within it. A private chat, a group without forum
 * topics, or a forum's General topic has no thread id.
 */
export interface Topic {
  chatId: number;
  messageThreadId?: number;
}

/** A command a topic answers, as it appears in the chat's command menu. */
export interface Command {
  /** Without the slash: lowercase letters, digits and underscores, as Telegram requires. */
  command: string;
  description: string;
}

export interface SwitchboardOptions {
  /** The API outbound calls go through: `bot.api`, with whatever transformers it has. */
  api: Api;
  /** Every topic by name. Updates from any other chat or thread go on to the next middleware. */
  topics: Record<string, Topic>;
  /** Each topic's commands; a topic left out has none. Replace them later with `setCommands`. */
  commands?: Record<string, readonly Command[]>;
  /** Keeps reply lineage and buttons too long to carry inline. Without it, neither exists. */
  store?: SwitchboardStore;
  /** Where skipped and recovered-from updates are reported; silent if left out. */
  logger?: Logger;
  /**
   * Delivers plain messages, replies and photos too. Off by default: only registered commands
   * and presses of the switchboard's own buttons are delivered, so in a group with privacy mode
   * off, other people's messages never reach the switchboard's handlers.
   */
  messages?: boolean;
  /** The Bot API server files are downloaded from, as given to the bot's client; Telegram's. */
  apiRoot?: string;
}

/** An inline button: the label it shows, and the action its press delivers. */
export interface Button {
  label: string;
  action: string;
}

/** A photo: a URL Telegram fetches, a `file_id` it already has, or an upload. */
export type Photo = string | InputFile;

export interface SendOptions {
  topic: string;
  /** The message, or a photo's caption (an album's, on its first photo). */
  text?: string;
  /** How `text` is written; plain if left out. */
  format?: TextFormat;
  /** One photo, captioned with `text`. */
  photo?: Photo;
  /** One photo, sent as `photo` is; or 2-10, sent as an album (which can't carry buttons). */
  photos?: readonly Photo[];
  /** Rows of inline buttons. */
  buttons?: readonly (readonly Button[])[];
  /** What the message is about: carried by its buttons' presses and by replies to it. */
  ref?: string;
  /** The message this one replies to, in the same topic; a reply to it also replies to that. */
  replyTo?: number;
  /** Pins the message (an album's first photo) once sent, without a notification. */
  pin?: boolean;
}

export interface SendResult {
  /** The message sent, or an album's messages in order. */
  messageIds: number[];
  /** For each photo sent, in order, the `file_id` Telegram gave it; empty for a text message. */
  fileIds: string[];
}

export interface EditOptions {
  topic: string;
  messageId: number;
  /** The new text, or the new caption when the message is a photo. */
  text?: string;
  format?: TextFormat;
  /** Replaces the message's photo. */
  photo?: Photo;
  /** Replaces the buttons; an empty list removes them. Left out, the buttons stay. */
  buttons?: readonly (readonly Button[])[];
  /**
   * The ref new buttons carry, which also becomes the message's own. Left out, the ref the
   * message was sent with is kept (when the store has it).
   */
  ref?: string;
  unpin?: boolean;
}

/** A file's bytes, downloaded through the Bot API. */
export interface DownloadedFile {
  data: Uint8Array;
  /** Telegram's path for the file, whose extension tells its type (`photos/file_1.jpg`). */
  filePath: string;
}

const DEFAULT_API_ROOT = "https://api.telegram.org";

/** Who sent an update (see `Sender`); undefined when Telegram reports no sender. */
function sender(user: User | undefined): Sender | undefined {
  if (!user) {
    return undefined;
  }
  const id = String(user.id);
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return { id, name: fullName || user.username || id };
}

/**
 * A leading bot command (`/status`, or `/status@ThisBot` as Telegram sends it in groups) as a
 * bare lowercased name and the trimmed rest. One addressed to another bot isn't a command here.
 */
function parseCommand(
  text: string,
  entities: readonly MessageEntity[] | undefined,
  botUsername: string,
): { command: string; args: string } | undefined {
  const first = entities?.[0];
  if (first?.type !== "bot_command" || first.offset !== 0) {
    return undefined;
  }
  const token = text.slice(1, first.length);
  const at = token.indexOf("@");
  const name = at === -1 ? token : token.slice(0, at);
  if (at !== -1 && token.slice(at + 1).toLowerCase() !== botUsername.toLowerCase()) {
    return undefined;
  }
  return { command: name.toLowerCase(), args: text.slice(first.length).trim() };
}

/**
 * Routes a bot's Telegram topics to typed handlers, and sends to them. Installed with
 * `bot.use(switchboard)`; it takes only the updates it delivers and hands everything else to the
 * next middleware.
 */
export class Switchboard<C extends Context = Context> implements MiddlewareObj<C> {
  readonly #api: Api;
  readonly #topics: Record<string, Topic>;
  readonly #commands = new Map<string, readonly Command[]>();
  readonly #store: SwitchboardStore | undefined;
  readonly #logger: Logger;
  readonly #messages: boolean;
  readonly #apiRoot: string;
  readonly #handlers = new Map<EventType, EventHandler<EventType, C>[]>();
  readonly #composer = new Composer<C>();

  constructor(options: SwitchboardOptions) {
    this.#api = options.api;
    this.#topics = { ...options.topics };
    this.#store = options.store;
    this.#logger = options.logger ?? silentLogger;
    this.#messages = options.messages ?? false;
    this.#apiRoot = options.apiRoot ?? DEFAULT_API_ROOT;
    for (const [topic, commands] of Object.entries(options.commands ?? {})) {
      this.setCommands(topic, commands);
    }
    this.#install();
  }

  /** The middleware grammY runs; `bot.use(switchboard)` calls it. */
  middleware(): MiddlewareFn<C> {
    return this.#composer.middleware();
  }

  /**
   * Adds a handler for one type of event; several run in the order added. An update whose event
   * has no handler goes on to the next middleware, as if the switchboard weren't there.
   */
  on<T extends EventType>(type: T, handler: EventHandler<T, C>): this {
    const handlers = this.#handlers.get(type) ?? [];
    handlers.push(handler as unknown as EventHandler<EventType, C>);
    this.#handlers.set(type, handlers);
    return this;
  }

  /** Replaces a topic's commands, in memory. The chat's menu changes on `registerCommandMenu`. */
  setCommands(topic: string, commands: readonly Command[]): void {
    this.#topic(topic);
    this.#commands.set(
      topic,
      commands.map(({ command, description }) => ({ command, description })),
    );
  }

  /** A topic's commands, as last given. */
  getCommands(topic: string): readonly Command[] {
    this.#topic(topic);
    return this.#commands.get(topic) ?? [];
  }

  /**
   * A chat's command menu: every topic's commands in that chat, merged, since Telegram scopes the
   * menu per chat and not per forum topic. A command more than one topic has appears once, with
   * the first description, in topic order.
   */
  commandMenu(chatId: number): BotCommand[] {
    const menu: BotCommand[] = [];
    for (const [topic, entry] of Object.entries(this.#topics)) {
      if (entry.chatId !== chatId) {
        continue;
      }
      for (const { command, description } of this.#commands.get(topic) ?? []) {
        if (!menu.some((existing) => existing.command === command)) {
          menu.push({ command, description });
        }
      }
    }
    return menu;
  }

  /**
   * Sets the menu of the chat a topic is in (chat scope), or clears it when no topic there has
   * commands. Throws if Telegram refuses.
   */
  async registerCommandMenu(topic: string): Promise<void> {
    await this.#registerChatMenu(this.#topic(topic).chatId);
  }

  /**
   * Sets every chat's menu, once the bot runs. A chat that fails is logged and skipped, so one
   * bad chat id doesn't leave the others without menus.
   */
  async registerCommandMenus(): Promise<void> {
    const chatIds = new Set(Object.values(this.#topics).map((entry) => entry.chatId));
    for (const chatId of chatIds) {
      try {
        await this.#registerChatMenu(chatId);
      } catch (error) {
        this.#logger.error("failed to register command menu", { chatId, error: String(error) });
      }
    }
  }

  /**
   * Sends a message, a photo or an album to a topic. Buttons are checked before anything is
   * sent: without a store, one that doesn't fit inline throws `ButtonTooLongError`. Each message
   * sent is recorded in the store with its ref and the message it replies to, so replies to it
   * and presses of its buttons arrive with the ref.
   */
  async send(options: SendOptions): Promise<SendResult> {
    const entry = this.#topic(options.topic);
    if (options.photo !== undefined && options.photos !== undefined) {
      throw new TypeError("Give either photo or photos, not both");
    }
    const photos = options.photo !== undefined ? [options.photo] : (options.photos ?? []);
    if (photos.length === 0 && options.text === undefined) {
      throw new TypeError("A message needs text or a photo");
    }
    if (photos.length > 1 && options.buttons) {
      throw new TypeError("An album can't carry buttons");
    }

    const reply_markup = await this.#keyboard(options.topic, options.ref, options.buttons);
    const reply_parameters: ReplyParameters | undefined =
      options.replyTo === undefined
        ? undefined
        : { message_id: options.replyTo, allow_sending_without_reply: true };
    const common = { message_thread_id: entry.messageThreadId, reply_parameters };

    let messages: Message[];
    if (photos.length > 1) {
      messages = await withFormat(this.#logger, options.text, options.format, (caption, mode) =>
        this.#api.sendMediaGroup(
          entry.chatId,
          photos.map((media, i) => ({
            type: "photo" as const,
            media,
            ...(i === 0 ? { caption, parse_mode: mode } : {}),
          })),
          common,
        ),
      );
    } else {
      const photo = photos[0];
      messages = [
        await withFormat<Message>(this.#logger, options.text, options.format, (text, parse_mode) =>
          photo === undefined
            ? this.#api.sendMessage(entry.chatId, text!, { ...common, parse_mode, reply_markup })
            : this.#api.sendPhoto(entry.chatId, photo, {
                ...common,
                caption: text,
                parse_mode,
                reply_markup,
              }),
        ),
      ];
    }

    const messageIds = messages.map((message) => message.message_id);
    if (this.#store) {
      for (const messageId of messageIds) {
        await this.#store.recordMessage({
          chatId: entry.chatId,
          messageId,
          topic: options.topic,
          ref: options.ref ?? null,
          parentMessageId: options.replyTo ?? null,
        });
      }
    }

    if (options.pin) {
      await this.#api.pinChatMessage(entry.chatId, messageIds[0]!, { disable_notification: true });
    }

    const fileIds = messages.flatMap((message) => {
      const largest = message.photo?.at(-1);
      return largest ? [largest.file_id] : [];
    });
    return { messageIds, fileIds };
  }

  /** Edits a message's text or caption, photo or buttons, and unpins it if asked. */
  async edit(options: EditOptions): Promise<void> {
    const entry = this.#topic(options.topic);

    const stored = await this.#store?.getMessage(entry.chatId, options.messageId);
    const ref = options.ref ?? stored?.ref ?? undefined;
    const reply_markup = await this.#keyboard(options.topic, ref, options.buttons);

    if (options.photo !== undefined) {
      const media = options.photo;
      await withFormat(this.#logger, options.text, options.format, (caption, parse_mode) =>
        this.#api.editMessageMedia(
          entry.chatId,
          options.messageId,
          { type: "photo", media, caption, parse_mode },
          { reply_markup },
        ),
      );
    } else if (options.text !== undefined) {
      await withFormat(this.#logger, options.text, options.format, (text, parse_mode) =>
        this.#api.editMessageText(entry.chatId, options.messageId, text!, {
          parse_mode,
          reply_markup,
        }),
      );
    } else if (reply_markup) {
      await this.#api.editMessageReplyMarkup(entry.chatId, options.messageId, { reply_markup });
    }

    // An explicit ref re-owns the message, so later replies agree with its new buttons.
    if (options.ref !== undefined && stored) {
      await this.#store!.recordMessage({ ...stored, ref: options.ref });
    }

    if (options.unpin) {
      await this.#api.unpinChatMessage(entry.chatId, options.messageId);
    }
  }

  async delete(options: { topic: string; messageId: number }): Promise<void> {
    const entry = this.#topic(options.topic);
    await this.#api.deleteMessage(entry.chatId, options.messageId);
  }

  /**
   * Shows the typing indicator in a topic. Telegram clears it after about 5 s or on the bot's
   * next message, so slow work refreshes it on an interval.
   */
  async typing(options: { topic: string }): Promise<void> {
    const entry = this.#topic(options.topic);
    await this.#api.sendChatAction(entry.chatId, "typing", {
      message_thread_id: entry.messageThreadId,
    });
  }

  /**
   * Downloads a file by its `file_id` (a `photo` event's `fileId`), in this process: the bot
   * token is in the download URL, which is never returned or put in an error. Telegram lets bots
   * download files of up to 20 MB.
   */
  async fetchFile(fileId: string): Promise<DownloadedFile> {
    const file = await this.#api.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) {
      throw new Error("Telegram gave no download path for the file (over 20 MB?)");
    }
    const token = this.#api.token;
    let response: Response;
    try {
      response = await fetch(`${this.#apiRoot}/file/bot${token}/${filePath}`);
    } catch (error) {
      throw new Error(`Failed to download file: ${String(error).replaceAll(token, "<token>")}`);
    }
    if (!response.ok) {
      throw new Error(`Failed to download file: HTTP ${response.status}`);
    }
    return { data: new Uint8Array(await response.arrayBuffer()), filePath };
  }

  #topic(name: string): Topic {
    const entry = this.#topics[name];
    if (!entry) {
      throw new UnknownTopicError(name);
    }
    return entry;
  }

  async #registerChatMenu(chatId: number): Promise<void> {
    const commands = this.commandMenu(chatId);
    const scope = { type: "chat", chat_id: chatId } as const;
    if (commands.length > 0) {
      await this.#api.setMyCommands(commands, { scope });
    } else {
      await this.#api.deleteMyCommands({ scope });
    }
    this.#logger.info("registered command menu", { chatId, commands: commands.length });
  }

  async #keyboard(
    topic: string,
    ref: string | undefined,
    buttons: readonly (readonly Button[])[] | undefined,
  ): Promise<InlineKeyboardMarkup | undefined> {
    if (!buttons) {
      return undefined;
    }
    const inline_keyboard = [];
    for (const row of buttons) {
      const keys = [];
      for (const button of row) {
        const callback_data = await buttonCallbackData(this.#store, {
          topic,
          ref,
          action: button.action,
        });
        keys.push({ text: button.label, callback_data });
      }
      inline_keyboard.push(keys);
    }
    return { inline_keyboard };
  }

  /**
   * The topic a message is in. A message in a forum topic matches by chat and thread. Telegram
   * also sets a thread id on a reply in a group without forum topics (the replied-to message's),
   * so a message not in a forum topic that matches no thread falls back to its chat's topic with
   * no thread id.
   */
  #topicOf(message: Message): string | undefined {
    const find = (threadId: number | undefined) =>
      Object.entries(this.#topics).find(
        ([, entry]) => entry.chatId === message.chat.id && entry.messageThreadId === threadId,
      )?.[0];
    const topic = find(message.message_thread_id);
    if (topic !== undefined || message.is_topic_message) {
      return topic;
    }
    return find(undefined);
  }

  #handles(type: EventType): boolean {
    return (this.#handlers.get(type)?.length ?? 0) > 0;
  }

  async #deliver(event: InboundEvent, ctx: C): Promise<void> {
    for (const handler of this.#handlers.get(event.type)!) {
      await handler(event, ctx);
    }
  }

  /**
   * The chain a person's message replies to, recording the message as its next link when the
   * parent is stored. Recorded before the event is delivered: the link depends only on the
   * parent, so a handler that fails can't leave later replies unrouted, and Telegram delivering
   * the update again writes the same row.
   */
  async #followReply(topic: string, message: Message): Promise<Lineage | undefined> {
    const parentMessageId = message.reply_to_message?.message_id;
    if (!this.#store || parentMessageId === undefined) {
      return undefined;
    }
    return recordReply(this.#store, {
      chatId: message.chat.id,
      messageId: message.message_id,
      topic,
      parentMessageId,
    });
  }

  #install(): void {
    this.#composer.on("callback_query:data", async (ctx, next) => {
      const data = ctx.callbackQuery.data;
      const button = await resolveCallbackData(this.#store, data);
      if (!button) {
        // Data in the switchboard's own format that doesn't decode is worth a line; anything
        // else may be another plugin's button.
        if (data.startsWith(INLINE_PREFIX)) {
          this.#logger.warn("unrecognised button data", { callbackData: data });
        }
        return next();
      }
      if (!this.#topics[button.topic]) {
        this.#logger.warn("button for a topic not registered", { topic: button.topic });
        return next();
      }
      if (!this.#handles("button")) {
        return next();
      }
      // Answered first, so the client's spinner stops however long the handler takes. A press
      // answered too late (after a restart) is still delivered.
      try {
        await ctx.answerCallbackQuery();
      } catch (error) {
        this.#logger.warn("failed to answer button press", { error: String(error) });
      }
      await this.#deliver(
        {
          type: "button",
          topic: button.topic,
          ref: button.ref,
          action: button.action,
          messageId: ctx.callbackQuery.message?.message_id,
          from: sender(ctx.callbackQuery.from),
        },
        ctx,
      );
    });

    this.#composer.on("message:text", async (ctx, next) => {
      const message = ctx.message;
      const topic = this.#topicOf(message);
      if (topic === undefined) {
        return next();
      }

      // Only a command the topic registered is a command; anything else is a plain message, so
      // a handler that reads unregistered commands itself still gets them.
      const parsed = parseCommand(message.text, message.entities, ctx.me.username);
      const registered = (this.#commands.get(topic) ?? []).some(
        ({ command }) => command.toLowerCase() === parsed?.command,
      );
      if (parsed && registered) {
        if (!this.#handles("command")) {
          return next();
        }
        return this.#deliver(
          {
            type: "command",
            topic,
            command: parsed.command,
            args: parsed.args,
            messageId: message.message_id,
            from: sender(message.from),
          },
          ctx,
        );
      }

      if (!this.#messages) {
        return next();
      }
      const lineage = await this.#followReply(topic, message);
      const event: InboundEvent = lineage
        ? {
            type: "reply",
            topic,
            ref: lineage.ref,
            text: message.text,
            messageId: message.message_id,
            from: sender(message.from),
          }
        : {
            type: "message",
            topic,
            text: message.text,
            messageId: message.message_id,
            from: sender(message.from),
          };
      if (!this.#handles(event.type)) {
        return next();
      }
      return this.#deliver(event, ctx);
    });

    this.#composer.on("message:photo", async (ctx, next) => {
      const message = ctx.message;
      const topic = this.#topicOf(message);
      const largest = message.photo.at(-1);
      if (topic === undefined || !this.#messages || !largest) {
        return next();
      }
      const lineage = await this.#followReply(topic, message);
      if (!this.#handles("photo")) {
        return next();
      }
      const event: EventOf<"photo"> = {
        type: "photo",
        topic,
        ref: lineage?.ref ?? null,
        fileId: largest.file_id,
        caption: message.caption,
        messageId: message.message_id,
        mediaGroupId: message.media_group_id,
        from: sender(message.from),
      };
      return this.#deliver(event, ctx);
    });
  }
}
