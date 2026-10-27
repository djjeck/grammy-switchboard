import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { type ButtonAction, type StoredMessage, type SwitchboardStore } from "./store.js";

// Telegram numbers messages per chat, so a message is keyed by its chat as well as its id; a
// reply's parent is always in the same chat.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    topic TEXT NOT NULL,
    ref TEXT,
    parent_message_id INTEGER,
    PRIMARY KEY (chat_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS button_callbacks (
    callback_id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    ref TEXT,
    action TEXT NOT NULL
  );
`;

// A stored button's id: 12 random bytes are 16 characters of base64url, which fit Telegram's 64
// bytes with room to spare and never start with the inline form's `~`.
const BUTTON_ID_BYTES = 12;

interface MessageRow {
  chat_id: number;
  message_id: number;
  topic: string;
  ref: string | null;
  parent_message_id: number | null;
}

/**
 * The switchboard's store on SQLite (`better-sqlite3`): a `messages` table for reply lineage and
 * a `button_callbacks` table for buttons too long to carry inline. Created if missing; any other
 * table in the database is left alone, so the store can share a database with its application.
 */
export class SqliteStore implements SwitchboardStore {
  /** The database, for an application that keeps tables of its own in it. */
  readonly db: Database.Database;
  readonly #owned: boolean;

  /**
   * Opens the database at `path` (in WAL mode), or uses an open `better-sqlite3` database as is.
   * Throws if its `messages` table is an older one not keyed by chat.
   */
  constructor(database: string | Database.Database) {
    this.#owned = typeof database === "string";
    this.db = typeof database === "string" ? new Database(database) : database;
    if (this.#owned) {
      this.db.pragma("journal_mode = WAL");
    }
    const columns = this.db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('messages')")
      .all();
    if (columns.length > 0 && !columns.some(({ name }) => name === "chat_id")) {
      throw new Error("The messages table has no chat_id column; migrate it before opening");
    }
    this.db.exec(SCHEMA);
  }

  recordMessage(message: StoredMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (chat_id, message_id, topic, ref, parent_message_id)
         VALUES (@chatId, @messageId, @topic, @ref, @parentMessageId)
         ON CONFLICT(chat_id, message_id) DO UPDATE SET
           topic = excluded.topic,
           ref = excluded.ref,
           parent_message_id = excluded.parent_message_id`,
      )
      .run(message);
  }

  getMessage(chatId: number, messageId: number): StoredMessage | undefined {
    const row = this.db
      .prepare<{ chatId: number; messageId: number }, MessageRow>(
        `SELECT chat_id, message_id, topic, ref, parent_message_id FROM messages
         WHERE chat_id = @chatId AND message_id = @messageId`,
      )
      .get({ chatId, messageId });
    return (
      row && {
        chatId: row.chat_id,
        messageId: row.message_id,
        topic: row.topic,
        ref: row.ref,
        parentMessageId: row.parent_message_id,
      }
    );
  }

  saveButton(button: ButtonAction): string {
    const callbackId = randomBytes(BUTTON_ID_BYTES).toString("base64url");
    this.db
      .prepare(
        `INSERT INTO button_callbacks (callback_id, topic, ref, action)
         VALUES (@callbackId, @topic, @ref, @action)`,
      )
      .run({ callbackId, topic: button.topic, ref: button.ref, action: button.action });
    return callbackId;
  }

  getButton(id: string): ButtonAction | undefined {
    return this.db
      .prepare<{ id: string }, ButtonAction>(
        "SELECT topic, ref, action FROM button_callbacks WHERE callback_id = @id",
      )
      .get({ id });
  }

  /** Closes the database if the store opened it; one it was given is the application's. */
  close(): void {
    if (this.#owned) {
      this.db.close();
    }
  }
}
