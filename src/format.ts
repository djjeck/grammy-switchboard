import { GrammyError } from "grammy";
import { htmlToPlain } from "./html.js";
import { type Logger } from "./logger.js";
import { markdownToTelegramHtml } from "./markdown.js";

/**
 * How a message's text is written: plain (the default); Markdown, sent as Telegram HTML; or
 * Telegram HTML written by the caller, sent as it is.
 */
export type TextFormat = "plain" | "markdown" | "html";

type ParseMode = "HTML" | undefined;

/**
 * Sends `text` formatted as asked. If Telegram can't parse the formatting, the text goes again as
 * plain text (Markdown as written; HTML as the text it shows, tags stripped and entities
 * unescaped): a formatting slip never costs the message. No text (a photo without a caption)
 * is sent as is.
 */
export async function withFormat<T>(
  logger: Logger,
  text: string | undefined,
  format: TextFormat | undefined,
  send: (text: string | undefined, parseMode: ParseMode) => Promise<T>,
): Promise<T> {
  if (text === undefined || (format !== "markdown" && format !== "html")) {
    return send(text, undefined);
  }
  try {
    return await send(format === "markdown" ? markdownToTelegramHtml(text) : text, "HTML");
  } catch (error) {
    if (!(error instanceof GrammyError && /can't parse entities/i.test(error.description))) {
      throw error;
    }
    logger.warn("formatting rejected, sending plain text", { error: error.description });
    return send(format === "html" ? htmlToPlain(text) : text, undefined);
  }
}
