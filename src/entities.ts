import { type MessageEntity } from "grammy/types";

/**
 * The text with each hidden link (a `text_link` entity: visible text that isn't its URL) written
 * inline as Markdown, `[label](url)`, so the URL travels with the text: to a model, a note, a
 * log. A bare URL is already in the text and stays as it is, as does every other entity.
 *
 * Entity offsets count UTF-16 code units, as JavaScript strings do, so they index the text as
 * is. Labels aren't escaped: the result is for reading, not a round trip back to entities.
 */
export function inlineLinks(text: string, entities?: readonly MessageEntity[]): string {
  const links = (entities ?? [])
    .filter((entity) => entity.type === "text_link")
    .sort((a, b) => a.offset - b.offset);
  let result = "";
  let end = 0;
  for (const link of links) {
    // Telegram never overlaps two links; skip one that would, rather than repeat text.
    if (link.offset < end) {
      continue;
    }
    result += text.slice(end, link.offset);
    result += `[${text.slice(link.offset, link.offset + link.length)}](${link.url})`;
    end = link.offset + link.length;
  }
  return result + text.slice(end);
}
