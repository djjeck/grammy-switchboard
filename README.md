# grammy-switchboard

A [grammY](https://grammy.dev) plugin that routes a Telegram bot's topics to typed handlers:
registered commands, presses of its own inline buttons and, if asked, messages, replies and
photos, each with the topic it arrived in, the ref of the conversation it belongs to, and who sent
it; and sends to those topics, with reply lineage and buttons that carry their own data. The full
documentation is still to be written; until then, see the doc comments in `src/`.
