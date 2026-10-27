/**
 * A message in a reply chain, keyed by its chat and id (Telegram numbers messages per chat): one
 * the switchboard sent, with its ref, or a person's reply to a stored message, with none of its
 * own.
 */
export interface StoredMessage {
  chatId: number;
  messageId: number;
  topic: string;
  ref: string | null;
  /** The message it replies to, in the same chat. */
  parentMessageId: number | null;
}

/** What a button press resolves to: the topic, ref and action it was sent with. */
export interface ButtonAction {
  topic: string;
  ref: string | null;
  action: string;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Where the switchboard keeps what Telegram doesn't: the reply chain of each message it sent, and
 * buttons too long to carry themselves in `callback_data`. Optional; without one there is no
 * lineage and buttons must fit inline. `grammy-switchboard/sqlite` has one on SQLite; any other
 * storage fits, synchronous or not.
 */
export interface SwitchboardStore {
  /** Inserts the message, or replaces the one with the same chat and id. */
  recordMessage(message: StoredMessage): MaybePromise<void>;
  getMessage(chatId: number, messageId: number): MaybePromise<StoredMessage | undefined>;
  /**
   * Stores a button and returns the id its `callback_data` will carry: at most 64 bytes, and not
   * starting with `~`, which marks a button carried inline. It is never deleted by the
   * switchboard: a button works as long as its message exists.
   */
  saveButton(button: ButtonAction): MaybePromise<string>;
  getButton(id: string): MaybePromise<ButtonAction | undefined>;
}

/** The topic and ref a chain belongs to. */
export interface Lineage {
  topic: string;
  ref: string | null;
}

/**
 * The owning ref of a stored message, walking up its parents: a reply inherits its parent's ref,
 * so a chain of any depth keeps the ref throughout (Telegram only reports the immediate parent).
 * Undefined when the message isn't stored.
 */
export async function resolveLineage(
  store: SwitchboardStore,
  chatId: number,
  messageId: number,
): Promise<Lineage | undefined> {
  let current = await store.getMessage(chatId, messageId);
  if (!current) {
    return undefined;
  }

  const seen = new Set<number>();
  while (current.ref === null && current.parentMessageId !== null) {
    // A cycle can't be written by the switchboard, but walking one would never end.
    if (seen.has(current.messageId)) {
      break;
    }
    seen.add(current.messageId);
    const parent: StoredMessage | undefined = await store.getMessage(
      chatId,
      current.parentMessageId,
    );
    if (!parent) {
      break;
    }
    current = parent;
  }

  return { topic: current.topic, ref: current.ref };
}

/**
 * The lineage of a person's message replying to `parentMessageId`, recording the message under
 * its parent (with no ref of its own) when the parent is stored, so a reply to it inherits the
 * chain. A reply to an unknown message (someone else's, or the forum-topic creation message
 * Telegram sets on every message in a topic) is not recorded: the store holds only known links.
 */
export async function recordReply(
  store: SwitchboardStore,
  reply: { chatId: number; messageId: number; topic: string; parentMessageId: number },
): Promise<Lineage | undefined> {
  const lineage = await resolveLineage(store, reply.chatId, reply.parentMessageId);
  if (lineage) {
    await store.recordMessage({ ...reply, ref: null });
  }
  return lineage;
}
