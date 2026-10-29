/**
 * What the switchboard hands its handlers when someone acts in a registered topic. They speak in
 * topics, refs and actions rather than Telegram updates; the update itself is still at hand as
 * the handler's grammY context.
 */

import { type MessageEntity } from "grammy/types";

/**
 * Who sent an update: Telegram's user id as a string and a display name (first and last name,
 * else the username, else the id). Whether a sender is allowed is the handler's decision.
 */
export interface Sender {
  id: string;
  name: string;
}

/**
 * Where a forwarded message first came from. A user's `id` and `name` are as for a `Sender`, so a
 * forward from someone the bot knows can be recognized; a group's or channel's are its chat id
 * and title. A user who hides their account when forwarded (`hidden_user`) has only the name
 * Telegram shows.
 */
export interface ForwardOrigin {
  type: "user" | "hidden_user" | "chat" | "channel";
  /** The user's or chat's id; left out for a hidden user. */
  id?: string;
  name: string;
  /** Whether the user is a bot; only for `user`. */
  isBot?: boolean;
  /** The author's signature on a channel post, or an anonymous group admin's message. */
  authorSignature?: string;
  /** When the original was sent, in Unix seconds. */
  date: number;
}

/** A command the topic registered, typed at the start of a message (`/status`, `/status@Bot`). */
export interface CommandEvent {
  type: "command";
  topic: string;
  /** The bare command, lowercased and without the slash or the bot's username. */
  command: string;
  /** The rest of the message, trimmed; empty when there is none. */
  args: string;
  messageId: number;
  /** Left out when Telegram reports no sender (a channel post). */
  from?: Sender;
}

/**
 * A text message that is neither a registered command nor a reply to a stored message.
 * Delivered only with `messages: true`.
 */
export interface MessageEvent {
  type: "message";
  topic: string;
  text: string;
  /**
   * Telegram's entities for `text`, as sent (left out when there are none): formatting, mentions,
   * and links, including hidden ones (`text_link`) whose URL isn't in the text. `inlineLinks`
   * writes those into the text.
   */
  entities?: MessageEntity[];
  messageId: number;
  from?: Sender;
  /** Set when the message is a forward: where it first came from (`from` forwarded it). */
  forwardedFrom?: ForwardOrigin;
}

/**
 * A text reply to a message the switchboard sent, or to a reply in that message's chain.
 * Delivered only with `messages: true`, and only with a store (without one, a reply is a
 * `message`).
 */
export interface ReplyEvent {
  type: "reply";
  topic: string;
  /** The ref the chain's bot message was sent with; null when it was sent without one. */
  ref: string | null;
  text: string;
  /**
   * Telegram's entities for `text`, as sent (left out when there are none): formatting, mentions,
   * and links, including hidden ones (`text_link`) whose URL isn't in the text. `inlineLinks`
   * writes those into the text.
   */
  entities?: MessageEntity[];
  messageId: number;
  from?: Sender;
  /** Set when the message is a forward: where it first came from (`from` forwarded it). */
  forwardedFrom?: ForwardOrigin;
}

/** A press of one of the switchboard's own inline buttons. */
export interface ButtonEvent {
  type: "button";
  topic: string;
  /** The ref the button was sent with; null when it was sent without one. */
  ref: string | null;
  action: string;
  /** The message the button is on; left out when Telegram doesn't say. */
  messageId?: number;
  /** Whoever pressed the button, not the author of the message it is on. */
  from?: Sender;
}

/**
 * A photo, in its largest size. The photos of one album arrive as separate events sharing a
 * `mediaGroupId`, and only the first carries the caption. Delivered only with `messages: true`.
 */
export interface PhotoEvent {
  type: "photo";
  topic: string;
  /** The chain's ref when the photo replies to a stored message; null otherwise. */
  ref: string | null;
  /** Telegram's `file_id`, to fetch the photo by (`fetchFile`) or send it again. */
  fileId: string;
  caption?: string;
  /** Telegram's entities for `caption`, as for a message's `entities`. */
  captionEntities?: MessageEntity[];
  messageId: number;
  mediaGroupId?: string;
  from?: Sender;
  /** Set when the photo is a forward, as for a message. */
  forwardedFrom?: ForwardOrigin;
}

export type InboundEvent = CommandEvent | MessageEvent | ReplyEvent | ButtonEvent | PhotoEvent;

export type EventType = InboundEvent["type"];

/** The event of one type. */
export type EventOf<T extends EventType> = Extract<InboundEvent, { type: T }>;

/**
 * Handles one type of event. The update is finished only once every handler for it has settled,
 * so a slow handler holds back the bot's next update (as any grammY middleware does). An error a
 * handler throws propagates to grammY, which hands it to `bot.catch`.
 */
export type EventHandler<T extends EventType, C> = (
  event: EventOf<T>,
  ctx: C,
) => void | Promise<void>;
