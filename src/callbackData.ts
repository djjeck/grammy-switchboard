import { ButtonTooLongError } from "./errors.js";
import { type ButtonAction, type SwitchboardStore } from "./store.js";

// Telegram's callback_data is 1-64 bytes of UTF-8.
export const CALLBACK_DATA_MAX_BYTES = 64;

// An inline button's data starts with this character, which no stored id may start with (the
// SQLite store's ids are base64url). Version 1 of the format; a later format takes another character
// outside base64url, so data already on messages keeps decoding as what it was sent as.
export const INLINE_PREFIX = "~";

export const encoder = new TextEncoder();
// Fatal, so a length that cuts a character in half is corrupt data rather than a U+FFFD.
const decoder = new TextDecoder("utf-8", { fatal: true });

// A lone surrogate has no UTF-8 form: Telegram would get U+FFFD and the press wouldn't match.
const LONE_SURROGATE = /\p{Surrogate}/u;

function field(value: string): string {
  return `${encoder.encode(value).length}:${value}`;
}

/**
 * The button itself as callback_data, when it fits: `~<topic bytes>:<topic>` then
 * `<ref bytes>:<ref>`, or `-` for no ref, then the action as the rest. Lengths are decimal
 * UTF-8 byte counts, so any character can appear in any field. Undefined when it doesn't fit.
 */
export function encodeInline(button: {
  topic: string;
  ref?: string;
  action: string;
}): string | undefined {
  const { topic, ref, action } = button;
  if ([topic, ref ?? "", action].some((value) => LONE_SURROGATE.test(value))) return undefined;
  const data = `${INLINE_PREFIX}${field(topic)}${ref === undefined ? "-" : field(ref)}${action}`;
  return encoder.encode(data).length <= CALLBACK_DATA_MAX_BYTES ? data : undefined;
}

// Reads `<n>:` and the n bytes after it from `bytes` at `at`; undefined if malformed.
function readField(bytes: Uint8Array, at: number): { value: string; next: number } | undefined {
  const colon = bytes.indexOf(0x3a, at);
  if (colon === -1) return undefined;
  const digits = String.fromCharCode(...bytes.subarray(at, colon));
  // Canonical decimal only, so each button has exactly one encoding.
  if (!/^(0|[1-9]\d*)$/.test(digits)) return undefined;
  const end = colon + 1 + Number(digits);
  if (end > bytes.length) return undefined;
  try {
    return { value: decoder.decode(bytes.subarray(colon + 1, end)), next: end };
  } catch {
    return undefined;
  }
}

/** Decodes `encodeInline`'s data; undefined for anything that isn't well-formed inline data. */
export function decodeInline(data: string): ButtonAction | undefined {
  if (!data.startsWith(INLINE_PREFIX)) return undefined;
  const bytes = encoder.encode(data);
  const topic = readField(bytes, INLINE_PREFIX.length);
  if (!topic) return undefined;
  let ref: string | null = null;
  let next = topic.next;
  if (bytes[next] === 0x2d) {
    next += 1;
  } else {
    const read = readField(bytes, next);
    if (!read) return undefined;
    ref = read.value;
    next = read.next;
  }
  // The rest is the action. It was a whole string, and the fields before it end on character
  // boundaries, so it decodes.
  return { topic: topic.value, ref, action: decoder.decode(bytes.subarray(next)) };
}

/**
 * A button's callback_data: the button itself when it fits, else the id the store keeps it
 * under. Without a store a button that doesn't fit throws, before anything is sent.
 */
export async function buttonCallbackData(
  store: SwitchboardStore | undefined,
  button: { topic: string; ref?: string; action: string },
): Promise<string> {
  const inline = encodeInline(button);
  if (inline !== undefined) return inline;
  if (!store) throw new ButtonTooLongError(button);
  const id = await store.saveButton({ ...button, ref: button.ref ?? null });
  // A stored id read back as inline data, or cut off by Telegram, would resolve to the wrong
  // button or none at all.
  if (
    id.startsWith(INLINE_PREFIX) ||
    id.length === 0 ||
    encoder.encode(id).length > CALLBACK_DATA_MAX_BYTES
  ) {
    throw new Error(`The store returned an unusable button id: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * The button a press's callback_data names, whichever form it was sent in; undefined for data
 * that isn't the switchboard's (another plugin's, corrupt, or an id the store doesn't have).
 */
export async function resolveCallbackData(
  store: SwitchboardStore | undefined,
  data: string,
): Promise<ButtonAction | undefined> {
  if (data.startsWith(INLINE_PREFIX)) return decodeInline(data);
  return store ? store.getButton(data) : undefined;
}
