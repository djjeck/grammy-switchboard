import { type ButtonAction, type StoredMessage, type SwitchboardStore } from "../src/store.js";

/**
 * A store in memory, for tests, answering through promises so the core is exercised with an
 * asynchronous store (the SQLite one is synchronous).
 */
export class MemoryStore implements SwitchboardStore {
  readonly messages = new Map<string, StoredMessage>();
  readonly buttons = new Map<string, ButtonAction>();
  #next = 0;

  async recordMessage(message: StoredMessage): Promise<void> {
    this.messages.set(`${message.chatId}:${message.messageId}`, { ...message });
  }

  async getMessage(chatId: number, messageId: number): Promise<StoredMessage | undefined> {
    return this.messages.get(`${chatId}:${messageId}`);
  }

  async saveButton(button: ButtonAction): Promise<string> {
    const id = `b${++this.#next}`;
    this.buttons.set(id, { ...button });
    return id;
  }

  async getButton(id: string): Promise<ButtonAction | undefined> {
    return this.buttons.get(id);
  }
}
