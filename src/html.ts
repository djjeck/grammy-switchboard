/**
 * Helpers for Telegram HTML written by the caller (`format: "html"`).
 *
 * Telegram's HTML needs only `<`, `>` and `&` escaped in text; `escapeHtml` does that, for text
 * from people (names, messages) put into HTML the caller builds. `htmlToPlain` reads such HTML
 * back as the text it shows, for the plain-text fallback and for places with no rich text.
 */

/** Escapes `&`, `<` and `>`, so the text shows as it is inside Telegram HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The text Telegram HTML shows: tags removed, and `&lt;`, `&gt;`, `&quot;` and `&amp;`
 * unescaped (`&amp;` last, so `&amp;lt;` reads `&lt;`).
 */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
