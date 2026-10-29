# grammy-switchboard

A grammY plugin that routes a Telegram bot's topics to typed handlers: registered commands, its
own inline buttons, and (if asked) messages, replies and photos, each with the topic it arrived in,
the ref of the conversation it belongs to, and who sent it. Extracted from a private gateway
service that ran the same code in production; this repo starts clean and holds nothing of that
service's deployment.

## Repository layout

```text
src/
  index.ts         — the main entry (`grammy-switchboard`): everything public except the store
  switchboard.ts   — the Switchboard: a grammY MiddlewareObj (inbound: updates → events for the
                     handlers given with `on`) and the outbound methods (send, edit, delete,
                     typing, command menus, fetchFile)
  events.ts        — the inbound events (command, message, reply, button, photo), camelCase
  entities.ts      — inlineLinks: a message's hidden links (text_link entities) written into
                     its text as Markdown
  callbackData.ts  — a button's callback_data: inline wire format v1 (`~`), or a store's id
  store.ts         — the store interface (messages for lineage, stored buttons) and the lineage
                     walk over it
  sqlite.ts        — the `grammy-switchboard/sqlite` entry: SqliteStore on better-sqlite3
  format.ts        — Markdown sent as Telegram HTML, resent as plain text if Telegram rejects it
  markdown.ts      — the Markdown → Telegram HTML converter
  errors.ts        — UnknownTopicError, ButtonTooLongError
  logger.ts        — the injected Logger interface and the silent default
tests/              — one *.test.ts per area; botApi.ts stubs the Bot API through an API
                     transformer; memoryStore.ts is a test-only asynchronous store
examples/
  ping/bot.ts      — a store-less bot: /ping and an inline-button round trip. Imports the package
                     by its own name (Node's self-reference, so it resolves to dist/: build
                     first); not published, not in coverage
.github/workflows/
  ci.yml           — on every push to a branch and every PR: format, lint, typecheck, build,
                     tests at 100% coverage (also called by release.yml)
  release.yml      — on a `v*` tag: the CI checks, the tag against package.json's version,
                     then `npm publish` through npm trusted publishing, with provenance
```

## Local validation

```sh
source ~/.nvm/nvm.sh && nvm use && npm run validate && npm run test:coverage
```

`validate` runs `build → test → typecheck → lint:fix → format`; it is the gate before every
commit. Coverage (100% on every metric, `vitest.config.ts`) is a separate script. `typecheck`
covers `src/`, `tests/` and `examples/` (`tsconfig.json`, whose `paths` point the package's own
name at `src/` so the examples typecheck without a build); `build` emits `src/` only
(`tsconfig.build.json`).
No Docker. CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `typecheck`, `build`
and `test:coverage`, so `validate`'s fixes must be committed.

## Releasing

Releases are published by GitHub Actions, never from a laptop (except the first, below):

1. Bump `version` in `package.json` (`npm version X.Y.Z --no-git-tag-version`, which updates the
   lockfile too), following semver (on 0.x a minor may break the API).
2. Turn the CHANGELOG's `Unreleased` section into `## [X.Y.Z] - YYYY-MM-DD`, with its link at the
   bottom.
3. Commit, then tag `vX.Y.Z` on that commit and push the commit and the tag.
   `release.yml` runs the checks, refuses a tag that doesn't match `package.json`, and publishes,
   unless that version is already on npm (as the first one is), which it leaves alone.

The first release is manual: npm can only attach a trusted publisher to a package that exists,
so the owner publishes the first version by hand and then configures the trusted publisher on
npmjs.com, as the comment at the top of `release.yml` describes. No npm token is ever stored in
the repository's secrets.

## Conventions

- ESM only, `"type": "module"`, NodeNext resolution: relative imports end in `.js`.
- `erasableSyntaxOnly`: no enums, namespaces or parameter properties, so the sources run under
  Node's type stripping as they are. Published as compiled JavaScript with `.d.ts` files, since
  Node never strips types under `node_modules`.
- Runtime dependencies: none. `grammy` is a peer dependency; `better-sqlite3` an optional peer,
  imported only by `src/sqlite.ts` (a test checks the main entry never loads it).
- Tests never reach Telegram: a real grammY `Bot` with `botInfo` set, every API call answered by
  the transformer in `tests/botApi.ts`. Examples use neutral data (topics like `ops`, chat ids
  like `-100123`), never real chats, tokens or people.
- Semver, on 0.x until the API has been tried by its first consumers: a 0.x minor may break the
  API. Every release gets a `CHANGELOG.md` entry.

## Key design decisions

- **A plugin, not a wrapper.** The consumer owns the `Bot`: creates it, installs API
  transformers (such as `@grammyjs/auto-retry`), starts it and retries a failed start. The
  switchboard is installed with `bot.use(switchboard)` and makes outbound calls through the `Api`
  it is given (`bot.api`). The library has no startup or retry code.
- **A `MiddlewareObj`, not a `Composer` subclass.** `bot.use` accepts any object with a
  `middleware()` method. Extending `Composer` would put its `on(filterQuery)` and the
  switchboard's `on(eventType)` under one name with different meanings, and expose `Composer`'s
  whole surface as if it were the switchboard's. An internal `Composer` does the filtering.
- **It takes only what it delivers.** An update is taken when it becomes an event that has at
  least one handler; everything else goes to `next()`: updates from a chat or thread with no
  topic, edited messages and other update types, messages while `messages` is off, an event type
  nobody registered a handler for, and button presses whose data isn't the switchboard's. So the
  consumer's own grammY handlers, and other plugins' buttons, work alongside it.
- **Commands only, by default.** Without `messages: true`, only registered commands and presses
  of the switchboard's own buttons are delivered, and nothing is recorded for other messages, so
  in a group with privacy mode off other people's messages never reach the switchboard's
  handlers. The gate covers only what the switchboard delivers. With messages on, an unregistered
  `/word` arrives as a `message`. A command is `/cmd` or `/cmd@ThisBot` (`ctx.me.username`), at
  the start of the message; one addressed to another bot is not a command.
- **Topics.** A topic is a chat id and an optional forum thread id. A message matches the topic
  with its chat and thread. Telegram also sets `message_thread_id` on a reply in a group without
  forum topics (to the replied-to message), so a message that isn't in a forum topic
  (`is_topic_message` unset) and matches no thread falls back to its chat's topic with no thread.
- **Commands are per topic, in memory.** Given in the options and replaced with `setCommands`
  (the consumer persists them if it wants). Telegram scopes a command menu per chat, not per forum
  topic, so a chat's menu merges its topics' commands, the first description of a duplicate
  winning; it is set in chat scope (`setMyCommands`, or `deleteMyCommands` when empty).
  `registerCommandMenus` sets every chat's and logs a chat that fails; `registerCommandMenu(topic)`
  sets one and throws, for a caller that reports the failure.
- **Reply lineage.** Telegram reports only a reply's immediate parent, so the store keeps each
  sent message (chat id, message id, topic, ref, parent) and a person's reply or photo whose
  parent is stored (with no ref of its own); the ref is found by walking up the parents, so a
  chain of any depth keeps its ref. Messages are keyed by chat and id, since Telegram numbers
  them per chat. A reply to an unknown message (someone else's, or the forum-topic creation
  message Telegram sets on every message in a topic) is never stored, nor is a plain message or a
  command. The link is written before the event is delivered, so a failing handler can't break
  routing for later replies, and a redelivered update writes the same row. A send with `replyTo`
  is recorded with that parent (and its own ref, which wins over the parent's). Without a store
  there is no lineage: a reply arrives as a plain `message`.
- **Buttons carry themselves when they fit.** `callback_data` is 1-64 bytes of UTF-8. Wire format
  version 1, which must not change byte for byte: `~<topic bytes>:<topic><ref bytes>:<ref><action>`,
  or `-` in place of the ref's length and value for no ref (an empty ref is `0:`); lengths are
  canonical decimal UTF-8 byte counts, so any character can be in any field, and the action is
  the rest. The topic is in the data because a press on a message the bot can no longer access
  carries no thread id. Anything longer is kept by the store under an id (the SQLite store's are
  16 characters of base64url); `~` is outside base64url, and a store's id may not start with it,
  so the forms can't be confused. A later format takes another character outside base64url and
  keeps decoding `~`. Decoding is strict (fatal UTF-8). Without a store, a button that doesn't fit
  throws `ButtonTooLongError` before anything is sent. Buttons never expire: a button works as
  long as its message exists, and a caller ends it by editing the keyboard away.
- **Button presses.** A press of the switchboard's own button (for a registered topic, with a
  `button` handler) is answered before the handlers run, so the client's spinner stops however
  long they take; a failed answer (a press too old after a restart) is logged and the press still
  delivered. Data in the `~` format that doesn't decode is logged; any other unknown data passes
  on silently, as it may be another plugin's.
- **Handler errors propagate.** Handlers run in order and are awaited, so a slow handler holds
  back the bot's next update as any middleware does. An error is not caught: grammY hands it to
  the consumer's `bot.catch`, which decides whether to log it or stop.
- **Events are camelCase** (`messageId`, `mediaGroupId`, `fileId`) and carry `topic` and `from`;
  `reply`, `button` and `photo` carry `ref` (null when none). `command` and `message` carry no
  ref: a message is by definition in no chain. Each handler also gets the grammY context.
- **Text keeps its entities.** `message` and `reply` carry `entities`, `photo` carries
  `captionEntities`, as Telegram sent them; `text` and `caption` are never rewritten. A hidden
  link's URL is only in its `text_link` entity, so without them a handler that forwards text on
  loses every such link; `inlineLinks` writes them into the text as `[label](url)` for one that
  wants a string.
- **A forward says where it came from.** `forwardedFrom` (`ForwardOrigin`) on `message`, `reply`
  and `photo`, from Telegram's `forward_origin`: a user named exactly as a `Sender` is, so a
  handler can recognize a forward from someone it knows, and `isBot`; a hidden user by name only;
  a group or channel by chat id and title. `from` stays whoever forwarded it.
- **Sending.** Text, a photo (a URL, a `file_id` or an `InputFile` upload), or an album of 2-10
  (captioned on its first photo, no buttons). Markdown is converted to Telegram HTML, which needs
  only `<`, `>` and `&` escaped, and resent as plain text if Telegram can't parse it. `replyTo` is
  sent as `reply_parameters` with `allow_sending_without_reply`, so a deleted parent doesn't cost
  the message. A send returns the message ids and, for each photo, the `file_id` Telegram
  assigned, so a caller can resend it without uploading again. An edit keeps the ref the message
  was sent with unless given a new one, which then becomes the message's.
- **Files are fetched in-process.** `fetchFile(fileId)` calls `getFile` and downloads the bytes;
  the download URL embeds the bot token, so it is never returned and is redacted from errors.
- **The logger is injected** (`info`, `warn`, `error`, each with a message and fields), silent if
  none is given; the library never writes to the console itself.
- **The SQLite store's schema** is `messages` keyed `(chat_id, message_id)` and
  `button_callbacks` keyed `callback_id`, created if missing. It opens an existing database with
  those tables as is and leaves any other table alone, so it can share a database with its
  application (given an open `better-sqlite3` database, it doesn't close it). A `messages` table
  of an older shape (no `chat_id`) is refused rather than migrated. The schema is to be reviewed
  before 1.0 (for example, rows keyed by a topic name a consumer may rename); a change ships as a
  migration in the store.
