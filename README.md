# grammy-switchboard

A [grammY](https://grammy.dev) plugin that routes a Telegram bot's **topics** to typed handlers,
and sends to them. You name the chats and forum topics your bot works in; the switchboard
delivers registered commands, presses of its own inline buttons and, if you ask, messages,
replies and photos, each with the topic it arrived in, the **ref** of the conversation it belongs
to, and who sent it. Sending speaks the same language: send to a topic by name, with a ref,
inline buttons, Markdown, photos or an album, and replies and button presses come back carrying
that ref.

```ts
await switchboard.send({
  topic: "ops",
  text: "Deploy finished. Roll back?",
  ref: "deploy-42",
  buttons: [[{ label: "Roll back", action: "rollback" }]],
});

switchboard.on("button", async ({ ref, action, from }) => {
  // ref === "deploy-42", action === "rollback", from === { id: "…", name: "…" }
});
```

## When to use it

Use it when a bot has to keep track of _what a message is about_ across the places it talks in:

- several chats or forum topics, each with its own commands and handlers;
- buttons whose presses should arrive as "action X on conversation Y in topic Z", without a
  lookup table of your own;
- replies (and replies to replies) that should be routed back to the conversation the bot's
  message started, which Telegram doesn't tell you beyond the immediate parent.

If your bot answers commands in one chat and has no buttons or conversations to keep apart, plain
grammY (and perhaps [its menu plugin](https://grammy.dev/plugins/menu)) is enough; this adds a
layer you won't use.

## Install

```sh
npm i grammy grammy-switchboard
```

`grammy` is a peer dependency. For the optional SQLite store (reply lineage and buttons too long
to carry inline), add `better-sqlite3`:

```sh
npm i better-sqlite3
```

The main entry never loads `better-sqlite3`; only `grammy-switchboard/sqlite` does.

## Quick start

The bot is yours: you create it, configure it and start it. The switchboard is installed on it
like any other middleware, and makes its outbound calls through the `Api` you give it.

```ts
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot } from "grammy";
import { Switchboard } from "grammy-switchboard";

const bot = new Bot(process.env.BOT_TOKEN!);
// Recommended: retry calls Telegram rate-limits or fails transiently.
bot.api.config.use(autoRetry());

const switchboard = new Switchboard({
  api: bot.api,
  topics: {
    ops: { chatId: -100123, messageThreadId: 7 }, // a forum topic
    alerts: { chatId: -100456 }, // a group without topics, or a private chat
  },
  commands: {
    ops: [{ command: "status", description: "Show the service status" }],
  },
});

switchboard.on("command", async (event) => {
  if (event.command === "status") {
    await switchboard.send({ topic: event.topic, text: "All good", replyTo: event.messageId });
  }
});

bot.use(switchboard);
bot.catch((error) => console.error(error.error));

await bot.start({ onStart: () => switchboard.registerCommandMenus() });
```

`@grammyjs/auto-retry` is a separate package (`npm i @grammyjs/auto-retry`); the switchboard
doesn't depend on it, and has no startup or retry code of its own.

A runnable store-less bot is in [`examples/ping`](examples/ping/bot.ts):

```sh
npm ci && npm run build
BOT_TOKEN=… CHAT_ID=-100123 [THREAD_ID=7] node --experimental-strip-types examples/ping/bot.ts
```

## Concepts

### Topics

A topic is a name for a place the bot talks in: a `chatId` and, for a forum topic, a
`messageThreadId`. A private chat, a group without forum topics, or a forum's General topic is a
topic without a thread id. Every call takes a topic by name; an unknown name throws
`UnknownTopicError`.

An update from a chat or thread that is no topic is not the switchboard's: it goes on to the next
middleware untouched. (Telegram also sets a thread id on a reply in a group without forum topics,
pointing at the replied-to message; a message that isn't in a forum topic and matches no thread
falls back to its chat's topic without a thread id.)

### Commands

Each topic has its own commands, given in `commands` and replaced with `setCommands`. They are
kept in memory only: persist them yourself if they change at run time. A command is `/cmd` or
`/cmd@YourBot` at the start of a message; one addressed to another bot is not a command. Only a
command registered for the topic it was typed in arrives as a `command` event.

Telegram scopes a bot's command menu per chat, not per forum topic, so a chat's menu merges the
commands of every topic in it (the first description of a duplicate wins).
`registerCommandMenus()` sets every chat's menu once the bot runs, logging and skipping a chat
that fails; `registerCommandMenu(topic)` sets one chat's and throws on failure.

### Refs

A ref is a string you choose that names what a message is about: an order, a deploy, a
conversation. Send a message with a ref, and every press of its buttons and every reply to it
(with a store) arrives with that ref, so a handler knows what was answered without looking it up.
`command` and `message` events have no ref: they start something rather than answer it.

### Lineage

Telegram reports only a reply's immediate parent. With a store, the switchboard records each
message it sends (with its ref and the message it replies to) and each person's reply to a stored
message, and finds a reply's ref by walking up the chain, so a reply to a reply to a reply still
arrives with the ref of the bot message that started it. A reply to a message the switchboard
doesn't know (someone else's) isn't recorded, and arrives as a plain `message`.

Without a store there is no lineage: every text reply arrives as a `message`, without a ref.

### Buttons and the 64-byte rule

Telegram gives an inline button at most 64 bytes of `callback_data`. When a button's topic, ref
and action fit in 64 bytes (in the [wire format](#button-wire-format-v1) below), the button carries
itself: no store, no table, and it keeps working across restarts. When they don't fit:

- with a store, the button is saved under a short id, which is what `callback_data` carries;
- without one, `send` (or `edit`) throws `ButtonTooLongError` before anything is sent.

Buttons never expire. A button works as long as its message exists; to end it, edit the keyboard
away (`edit({ …, buttons: [] })`). A press is answered (`answerCallbackQuery`) before your
handlers run, so the client's spinner stops however long they take.

### Store or no store

|                        | No store                                 | With a store                               |
| ---------------------- | ---------------------------------------- | ------------------------------------------ |
| Buttons                | Inline only; one that doesn't fit throws | Inline when they fit, stored otherwise     |
| Replies                | Arrive as `message`, without a ref       | Arrive as `reply`, with the chain's ref    |
| Photos                 | `ref` is always `null`                   | `ref` is the chain's, when replying to one |
| `edit` without a `ref` | New buttons carry no ref                 | New buttons keep the message's ref         |

A store is any object implementing `SwitchboardStore` (four methods, synchronous or asynchronous);
`grammy-switchboard/sqlite` provides one.

### Commands only, by default

By default (`messages: false`) the switchboard delivers only two things: commands registered for
the topic, and presses of its own buttons. Plain messages, replies and photos are neither
delivered nor recorded. In a group where the bot has privacy mode off, other people's messages
(and their user ids) therefore never reach the switchboard's handlers.

With `messages: true`, text messages, replies and photos in registered topics are delivered too,
and an unregistered `/word` arrives as a plain `message`.

The gate covers only what the switchboard delivers. Your own grammY handlers on the same bot see
everything grammY gives them, as they would without the switchboard.

### Taking only what it delivers

An update is taken only when it becomes an event with at least one handler. Everything else goes
to `next()`: updates from chats or threads with no topic, edited messages and other update types,
messages while `messages` is off, event types nobody registered a handler for, and button presses
whose data isn't the switchboard's. Your own handlers, and other plugins' buttons, keep working
alongside it.

## API

Everything is exported from `grammy-switchboard`, except the SQLite store, which is at
`grammy-switchboard/sqlite`.

### `new Switchboard<C extends Context = Context>(options)`

`C` is your bot's context type; handlers receive it as their second argument.

| Option     | Type                                 |                                                                                   |
| ---------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| `api`      | `Api`                                | Outbound calls go through it: `bot.api`, with its transformers. Required.         |
| `topics`   | `Record<string, Topic>`              | Every topic by name. Required.                                                    |
| `commands` | `Record<string, readonly Command[]>` | Each topic's commands; a topic left out has none.                                 |
| `store`    | `SwitchboardStore`                   | Reply lineage and stored buttons. Without it, neither exists.                     |
| `logger`   | `Logger`                             | Where skipped and recovered-from updates are reported. Silent by default.         |
| `messages` | `boolean`                            | Deliver messages, replies and photos too. Default `false`.                        |
| `apiRoot`  | `string`                             | The Bot API server files are downloaded from. Default `https://api.telegram.org`. |

```ts
interface Topic {
  chatId: number;
  messageThreadId?: number;
}

interface Command {
  command: string; // without the slash: lowercase letters, digits, underscores
  description: string;
}
```

### Inbound

#### `switchboard.on(type, handler)`

Adds a handler for one event type (`"command"`, `"message"`, `"reply"`, `"button"`, `"photo"`)
and returns the switchboard. Several handlers for a type run in the order added, each awaited, so
a slow handler holds back the bot's next update as any grammY middleware does. Errors propagate to
grammY, which hands them to `bot.catch`.

```ts
type EventHandler<T extends EventType, C> = (event: EventOf<T>, ctx: C) => void | Promise<void>;
```

#### Events

Every event has `type` and `topic`, and `from?: Sender` (left out when Telegram reports no
sender, as for a channel post). A `Sender` is `{ id: string; name: string }`: the Telegram user id
as a string, and their first and last name, else username, else id. Whether a sender is allowed
is your handler's call.

| Event          | Fields                                                                                                                         | Delivered                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `CommandEvent` | `command` (lowercased, no slash or `@bot`), `args` (the rest, trimmed), `messageId`                                            | Always, for registered commands       |
| `MessageEvent` | `text`, `entities?`, `messageId`, `forwardedFrom?`                                                                             | With `messages: true`                 |
| `ReplyEvent`   | `ref: string \| null`, `text`, `entities?`, `messageId`, `forwardedFrom?`                                                      | With `messages: true` and a store     |
| `ButtonEvent`  | `ref: string \| null`, `action`, `messageId?` (the button's message), `from` is the presser                                    | Always, for the switchboard's buttons |
| `PhotoEvent`   | `ref: string \| null`, `fileId` (largest size), `caption?`, `captionEntities?`, `messageId`, `mediaGroupId?`, `forwardedFrom?` | With `messages: true`                 |

An album's photos arrive as separate `photo` events sharing a `mediaGroupId`; only the first
carries the caption. `InboundEvent` is the union of all five, `EventType` its `type`, and
`EventOf<T>` the event of one type.

`entities` and `captionEntities` are Telegram's `MessageEntity[]` for the text or caption, as
sent, and left out when there are none. A link whose visible text isn't its URL (a word, or a
citation marker like `[1]`) is a `text_link` entity there: its URL is nowhere in the text itself.

A forwarded message or photo has `forwardedFrom: ForwardOrigin`, where it first came from (its
`from` is whoever forwarded it): `type` (`"user"`, `"hidden_user"`, `"chat"` or `"channel"`),
`id?` and `name` (a user's as for a `Sender`, so a forward from someone you know can be
recognized; a group's or channel's chat id and title; a hidden user has only a name), `isBot?`
(users only), `authorSignature?` and `date` (Unix seconds).

#### `inlineLinks(text, entities?): string`

Returns the text with each `text_link` written inline as Markdown, `[label](url)`, for a handler
that passes messages on as text (to a model, a note, a log) and would otherwise lose the URLs.
Bare URLs and other entities are left as they are, and labels aren't escaped.

```ts
switchboard.on("message", (event) => save(inlineLinks(event.text, event.entities)));
```

### Outbound

#### `switchboard.send(options): Promise<SendResult>`

Sends a text message, a photo or an album to a topic.

| Option    | Type                             |                                                                         |
| --------- | -------------------------------- | ----------------------------------------------------------------------- |
| `topic`   | `string`                         | Required.                                                               |
| `text`    | `string`                         | The message, or a photo's caption (an album's, on its first photo).     |
| `format`  | `"plain" \| "markdown"`          | Default `"plain"`. See [Formatting](#formatting).                       |
| `photo`   | `Photo`                          | One photo, captioned with `text`.                                       |
| `photos`  | `readonly Photo[]`               | One photo, or 2-10 sent as an album. Not with `photo`.                  |
| `buttons` | `readonly (readonly Button[])[]` | Rows of inline buttons, `{ label, action }`. Not on an album.           |
| `ref`     | `string`                         | What the message is about; carried by its buttons and by replies to it. |
| `replyTo` | `number`                         | A message id in the same topic to reply to.                             |
| `pin`     | `boolean`                        | Pin the message (an album's first) once sent, without a notification.   |

A `Photo` is a URL Telegram fetches, a `file_id` it already has, or an `InputFile` upload.
`replyTo` is sent with `allow_sending_without_reply`, so a deleted parent doesn't cost the
message, and the message is recorded under that parent for lineage (its own ref, if given, wins
over the parent's). Buttons are checked before anything is sent.

```ts
interface SendResult {
  messageIds: number[]; // the message, or an album's messages in order
  fileIds: string[]; // each photo's file_id, to resend without uploading again
}
```

#### `switchboard.edit(options): Promise<void>`

Edits a message's text or caption, photo or buttons. Options: `topic`, `messageId`, and any of
`text`, `format`, `photo` (replaces the photo), `buttons` (replaces them; `[]` removes them; left
out, they stay), `ref` (new buttons carry it, and it becomes the message's ref; left out, the ref
the message was sent with is kept when the store has it) and `unpin`.

#### `switchboard.delete({ topic, messageId }): Promise<void>`

Deletes a message.

#### `switchboard.typing({ topic }): Promise<void>`

Shows the typing indicator in a topic. Telegram clears it after about 5 seconds or on the bot's
next message; refresh it on an interval for slow work.

#### `switchboard.fetchFile(fileId): Promise<DownloadedFile>`

Downloads a file (for example a `PhotoEvent`'s `fileId`) in this process, returning
`{ data: Uint8Array; filePath: string }`. The download URL contains the bot token, so it is never
returned, and the token is redacted from errors. Telegram lets bots download files up to 20 MB.

#### Command menus

- `setCommands(topic, commands)`: replaces a topic's commands, in memory.
- `getCommands(topic)`: a topic's commands, as last given.
- `commandMenu(chatId)`: the merged menu of a chat, as `BotCommand[]`.
- `registerCommandMenu(topic): Promise<void>`: sets the menu of the topic's chat in chat scope
  (`setMyCommands`, or `deleteMyCommands` when empty). Throws if Telegram refuses.
- `registerCommandMenus(): Promise<void>`: sets every chat's menu; a chat that fails is logged and
  skipped.

#### `switchboard.middleware()`

The middleware grammY runs; `bot.use(switchboard)` calls it for you.

### Formatting

With `format: "markdown"`, text is converted to Telegram HTML: bold, italic, strikethrough, inline
code, code blocks and links; a heading becomes a bold line and a list item gets a bullet. HTML
needs only `<`, `>` and `&` escaped, so Markdown written by people or models doesn't trip over
MarkdownV2's escaping rules. If Telegram still can't parse the result, the text is sent again as
plain text, and a warning is logged. The converter is exported as
`markdownToTelegramHtml(markdown): string`.

### Logging

```ts
type LogFields = Record<string, unknown>;

interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
```

The switchboard reports what it skipped or recovered from (unrecognised button data, a button for
an unregistered topic, a press it couldn't answer, rejected formatting, a command menu that
failed). `console` fits, as do pino and most loggers. `silentLogger`, the default, logs nothing;
the library never writes to the console on its own.

### Errors

- `UnknownTopicError` (`.topic`): a call named a topic the switchboard wasn't given.
- `ButtonTooLongError` (`.button`: `{ topic, ref?, action }`): a button doesn't fit inline and
  there is no store. Thrown before anything is sent.

Errors from the Bot API are grammY's own (`GrammyError`, `HttpError`).

### Stores

```ts
interface SwitchboardStore {
  recordMessage(message: StoredMessage): MaybePromise<void>; // insert, or replace same chat + id
  getMessage(chatId: number, messageId: number): MaybePromise<StoredMessage | undefined>;
  saveButton(button: ButtonAction): MaybePromise<string>; // returns the id callback_data carries
  getButton(id: string): MaybePromise<ButtonAction | undefined>;
}

interface StoredMessage {
  chatId: number;
  messageId: number;
  topic: string;
  ref: string | null;
  parentMessageId: number | null;
}

interface ButtonAction {
  topic: string;
  ref: string | null;
  action: string;
}
```

An id returned by `saveButton` must be 1-64 bytes and must not start with `~`; the switchboard
never deletes a button. Messages are keyed by chat and id, since Telegram numbers messages per
chat.

#### `SqliteStore` (`grammy-switchboard/sqlite`)

```ts
import { SqliteStore } from "grammy-switchboard/sqlite";

const store = new SqliteStore("switchboard.db"); // or an open better-sqlite3 Database
const switchboard = new Switchboard({ api: bot.api, topics, store });
```

- `new SqliteStore(pathOrDatabase)`: opens the file (in WAL mode), or uses an open
  `better-sqlite3` database as is. Creates its tables if missing (`messages`, keyed by
  `(chat_id, message_id)`, and `button_callbacks`, keyed by `callback_id`) and leaves any other
  table alone, so it can share a database with your application. Stored button ids are 16
  characters of base64url.
- `store.db`: the database, for tables of your own.
- `store.close()`: closes the database if the store opened it; one it was given is yours to close.

The schema may change before 1.0; a change would ship as a migration in the store.

## Button wire format (v1)

This is a stable contract: buttons already on messages must keep working across versions, so
version 1 never changes byte for byte.

An inline button's `callback_data` is:

```text
~<topic length>:<topic><ref length>:<ref><action>
```

or, for a button sent without a ref, `-` in place of the ref's length and value:

```text
~<topic length>:<topic>-<action>
```

- `~` marks the inline form, version 1.
- Lengths are UTF-8 byte counts in canonical decimal (`0`, or no leading zeros), so any character,
  including `:` and `~`, can appear in any field.
- An empty ref is `0:`, distinct from no ref (`-`).
- The action is the rest of the data.
- The whole is at most 64 bytes of UTF-8. Decoding is strict: malformed data, or a length that
  cuts a character in half, is not a button.

For example, topic `ops`, ref `deploy-42` and action `rollback` encode as
`~3:ops9:deploy-42rollback`; with no ref, `~3:ops-rollback`.

Data that doesn't start with `~` is a stored button's id, looked up in the store. Stored ids never
start with `~`, so the two can't be confused. A later format would take another character outside
base64url, and `~` would keep decoding as version 1. The topic is in the data because a press on a
message the bot can no longer access carries no thread id.

Data in neither form, or a stored id the store doesn't have, is not the switchboard's and goes to
the next middleware untouched, so other plugins' buttons work alongside it.

## Design decisions

- **A plugin, not a wrapper.** The consumer owns the `Bot`: creates it, installs API transformers
  (such as `@grammyjs/auto-retry`), starts it, and retries a failed start if it wants to. The
  library has no startup or retry code.
- **A `MiddlewareObj`, not a `Composer` subclass.** `bot.use` accepts any object with a
  `middleware()` method. Extending `Composer` would put its `on(filterQuery)` and the
  switchboard's `on(eventType)` under one name with different meanings, and expose `Composer`'s
  whole surface as if it were the switchboard's.
- **It takes only what it delivers**, and passes everything else to `next()` (see
  [above](#taking-only-what-it-delivers)).
- **Commands only, by default**, so turning privacy mode off doesn't hand other people's messages
  to your handlers unless you ask for them.
- **Commands are per topic, in memory.** The switchboard keeps no configuration of its own;
  persisting commands is the consumer's choice.
- **Buttons carry themselves when they fit**, in a versioned wire format, and need a store only
  when they don't. Buttons never expire: a caller ends one by editing the keyboard away.
- **The store is optional and pluggable**, synchronous or not. The SQLite store is a separate
  entry point, so the core never loads a native module.
- **Lineage is written before delivery.** A reply's link depends only on its parent, so it is
  recorded before handlers run: a failing handler can't break routing for later replies, and a
  redelivered update writes the same row.
- **Handler errors propagate** to grammY's `bot.catch`; the switchboard doesn't swallow them.
- **Events are camelCase** (`messageId`, `fileId`, `mediaGroupId`), not Telegram's snake_case.
- **Files are fetched in-process**, so the bot token, which is in Telegram's download URL, never
  leaves it.
- **The logger is injected**, silent by default.
- **Markdown goes out as HTML** with a plain-text fallback: a formatting slip never costs the
  message.
- **No runtime dependencies.** `grammy` is a peer dependency, `better-sqlite3` an optional one.

## Compatibility

- Node.js 22 or later.
- grammY `^1.46.0` (peer dependency); `better-sqlite3` `^12.0.0` for the SQLite store.
- ESM only (`import`, not `require`).
- Ships compiled JavaScript with `.d.ts` types, so it works in projects that run their own `.ts`
  sources with Node's type stripping (Node never strips types under `node_modules`).

## Status

0.x: the API may still change, and a 0.x minor release may break it. Changes are listed in the
[CHANGELOG](CHANGELOG.md).

## License

[MIT](LICENSE)
