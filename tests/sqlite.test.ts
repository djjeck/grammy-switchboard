import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/sqlite.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tables(db: Database.Database): string[] {
  return db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
}

describe("SqliteStore", () => {
  it("creates its tables in a new database, in WAL mode, and reopens it", () => {
    const path = join(dir, "bot.db");
    const store = new SqliteStore(path);
    store.recordMessage({
      chatId: -100123,
      messageId: 5,
      topic: "ops",
      ref: "incident:1",
      parentMessageId: null,
    });

    expect(tables(store.db)).toEqual(["button_callbacks", "messages"]);
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    store.close();

    const reopened = new SqliteStore(path);
    expect(reopened.getMessage(-100123, 5)?.ref).toBe("incident:1");
    reopened.close();
  });

  it("round-trips messages, keyed by chat and id, replacing one recorded again", () => {
    const store = new SqliteStore(":memory:");
    const message = { chatId: -100123, messageId: 5, topic: "ops", ref: null, parentMessageId: 4 };
    store.recordMessage(message);
    store.recordMessage({ ...message, chatId: -100456, ref: "other" });

    expect(store.getMessage(-100123, 5)).toEqual(message);
    expect(store.getMessage(-100456, 5)?.ref).toBe("other");
    expect(store.getMessage(-100123, 6)).toBeUndefined();

    store.recordMessage({ ...message, ref: "incident:2", parentMessageId: null });
    expect(store.getMessage(-100123, 5)).toEqual({
      ...message,
      ref: "incident:2",
      parentMessageId: null,
    });
  });

  it("stores buttons under random base64url ids", () => {
    const store = new SqliteStore(":memory:");
    const button = { topic: "support", ref: null, action: "close" };
    const id = store.saveButton(button);

    expect(id).toMatch(/^[\w-]{16}$/);
    expect(store.saveButton(button)).not.toBe(id);
    expect(store.getButton(id)).toEqual(button);
    expect(store.getButton("AAAAAAAAAAAAAAAA")).toBeUndefined();
  });

  it("opens a database with the same schema and other tables as is, leaving them alone", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE messages (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        topic TEXT NOT NULL,
        ref TEXT,
        parent_message_id INTEGER,
        PRIMARY KEY (chat_id, message_id)
      );
      CREATE TABLE button_callbacks (
        callback_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        ref TEXT,
        action TEXT NOT NULL
      );
      CREATE TABLE topic_commands (topic TEXT PRIMARY KEY, commands TEXT NOT NULL);
      INSERT INTO messages VALUES (-100123, 5, 'ops', 'incident:1', NULL);
      INSERT INTO button_callbacks VALUES ('AAAAAAAAAAAAAAAA', 'ops', 'incident:1', 'ack');
      INSERT INTO topic_commands VALUES ('ops', '[]');
    `);

    const store = new SqliteStore(db);

    expect(store.getMessage(-100123, 5)?.ref).toBe("incident:1");
    expect(store.getButton("AAAAAAAAAAAAAAAA")).toEqual({
      topic: "ops",
      ref: "incident:1",
      action: "ack",
    });
    expect(tables(db)).toEqual(["button_callbacks", "messages", "topic_commands"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM topic_commands").get()).toEqual({ n: 1 });

    // The database is the application's, so closing the store leaves it open.
    store.close();
    expect(db.open).toBe(true);
    db.close();
  });

  it("refuses a messages table not keyed by chat", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE messages (message_id INTEGER PRIMARY KEY, topic TEXT, ref TEXT)");

    expect(() => new SqliteStore(db)).toThrow(/no chat_id column/);
    db.close();
  });
});
