/** A call named a topic the switchboard wasn't given. */
export class UnknownTopicError extends Error {
  readonly topic: string;

  constructor(topic: string) {
    super(`Unknown topic: ${topic}`);
    this.topic = topic;
    this.name = "UnknownTopicError";
  }
}

/**
 * A button's topic, ref and action don't fit in Telegram's 64 bytes of `callback_data`, and
 * there is no store to keep the button in. Thrown before anything is sent.
 */
export class ButtonTooLongError extends Error {
  readonly button: { topic: string; ref?: string; action: string };

  constructor(button: { topic: string; ref?: string; action: string }) {
    super(
      `Button "${button.action}" in topic "${button.topic}" doesn't fit in callback_data ` +
        "with its topic and ref, and there is no store to keep it in",
    );
    this.button = button;
    this.name = "ButtonTooLongError";
  }
}
