# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/); while it is on 0.x, a minor release may break the API.

## [Unreleased]

### Added

- `entities` on `message` and `reply` events and `captionEntities` on `photo` events: Telegram's
  entities as sent, so a hidden link's URL (a `text_link`) reaches the handler (#3).
- `inlineLinks(text, entities?)`, which writes each hidden link into the text as `[label](url)`.

## [0.1.0] - 2026-10-27

The first release.

### Added

- `Switchboard`, a grammY plugin installed with `bot.use(switchboard)` on a bot the consumer owns.
- Topics: named chats and forum topics; updates from anywhere else pass to the next middleware.
- Per-topic commands in memory (`commands`, `setCommands`, `getCommands`), and per-chat command
  menus merged from a chat's topics (`commandMenu`, `registerCommandMenu`,
  `registerCommandMenus`).
- Typed inbound events with camelCase fields, each with its topic and sender: `command` and
  `button` always; `message`, `reply` and `photo` only with `messages: true`.
- Refs: carried by a message's buttons and, with a store, by replies to it.
- Reply lineage with a store: a reply of any depth arrives with the ref of the bot message that
  started its chain.
- Inline buttons that carry their topic, ref and action in `callback_data` (wire format v1),
  stored under an id when they don't fit, or `ButtonTooLongError` without a store. Presses are
  answered before handlers run; buttons never expire.
- Outbound `send` (text, a photo by URL, `file_id` or upload, or an album of 2-10; `replyTo`,
  `pin`), returning message ids and each photo's `file_id`; `edit` (text, caption, photo,
  buttons, ref, `unpin`), `delete` and `typing`.
- Markdown sent as Telegram HTML, resent as plain text if Telegram rejects it;
  `markdownToTelegramHtml`.
- `fetchFile`: downloads a file in-process without exposing the bot token.
- An injected `Logger` interface, silent by default (`silentLogger`).
- `UnknownTopicError` and `ButtonTooLongError`.
- The `SwitchboardStore` interface, synchronous or asynchronous.
- `grammy-switchboard/sqlite`: `SqliteStore` on `better-sqlite3`, an optional peer dependency.

[0.1.0]: https://github.com/djjeck/grammy-switchboard/tree/v0.1.0
