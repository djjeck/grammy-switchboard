import { GrammyError } from "grammy";
import { type Logger } from "./logger.js";
import { markdownToTelegramHtml } from "./markdown.js";

/** How a message's text is written: plain (the default), or Markdown, sent as Telegram HTML. */
export type TextFormat = "plain" | "markdown";

type ParseMode = "HTML" | undefined;

/**
 * Sends `text` formatted as asked. If Telegram can't parse the formatting, the text goes again as
 * plain text: a formatting slip never costs the message. No text (a photo without a caption)
 * is sent as is.
 */
export async function withFormat<T>(
  logger: Logger,
  text: string | undefined,
  format: TextFormat | undefined,
  send: (text: string | undefined, parseMode: ParseMode) => Promise<T>,
): Promise<T> {
  if (text === undefined || format !== "markdown") return send(text, undefined);
  try {
    return await send(markdownToTelegramHtml(text), "HTML");
  } catch (error) {
    if (!(error instanceof GrammyError && /can't parse entities/i.test(error.description))) {
      throw error;
    }
    logger.warn("formatting rejected, sending plain text", { error: error.description });
    return send(text, undefined);
  }
}
