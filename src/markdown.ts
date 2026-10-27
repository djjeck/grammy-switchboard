/**
 * Markdown, as a model writes it, to Telegram's HTML.
 *
 * Telegram's own MarkdownV2 rejects a message unless a dozen characters (`.`, `-`, `!`, `(`, ...)
 * are escaped, which model output never does reliably. HTML needs only `<`, `>` and `&`
 * escaped, so a small Markdown subset is converted here and everything else is left as text:
 * bold, italic, strikethrough, inline code, code blocks, links; a heading becomes a bold line and
 * a list item gets a bullet, since Telegram has neither.
 */

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline formatting of text that has no code in it (already escaped). */
function inline(text: string): string {
  return (
    text
      // Links first, so the formatting below doesn't reach into a URL.
      .replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
        (_, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
      )
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<b>$1</b>")
      .replace(/__(?=\S)(.+?)(?<=\S)__/g, "<b>$1</b>")
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<s>$1</s>")
      // Single * or _ only around a word-bounded span, so snake_case and 2*3*4 stay as they are.
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "$1<i>$2</i>")
      .replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, "$1<i>$2</i>")
  );
}

/** One line outside code blocks: headings and list items, then inline formatting and code. */
function line(text: string): string {
  const heading = /^#{1,6}\s+(.*)$/.exec(text);
  if (heading) return `<b>${line(heading[1]!)}</b>`;
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(text);
  const content = bullet ? bullet[2]! : text;
  // Inline code is taken out first: nothing inside it is formatted. Splitting on a capturing
  // group puts the code spans at the odd indices.
  const html = content
    .split(/(`[^`\n]+`)/)
    .map((part, i) =>
      i % 2 === 1 ? `<code>${escape(part.slice(1, -1))}</code>` : inline(escape(part)),
    )
    .join("");
  return bullet ? `${bullet[1]}• ${html}` : html;
}

export function markdownToTelegramHtml(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*```/.exec(lines[i]!);
    if (fence) {
      const end = lines.findIndex((l, j) => j > i && /^\s*```\s*$/.test(l));
      if (end !== -1) {
        out.push(`<pre>${escape(lines.slice(i + 1, end).join("\n"))}</pre>`);
        i = end;
        continue;
      }
    }
    out.push(line(lines[i]!));
  }
  return out.join("\n");
}
