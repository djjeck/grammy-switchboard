/**
 * A store-less bot with one topic: `/ping` answers with two inline buttons, and pressing them
 * edits the answer. Every button carries its topic, ref and action inline (no store), so the
 * round trip survives a restart of the bot.
 *
 * Run it from the repository root, after `npm run build` (the example imports the package by its
 * own name, which resolves to `dist/`):
 *
 *   BOT_TOKEN=123:abc CHAT_ID=-100123 node --experimental-strip-types examples/ping/bot.ts
 *
 * Set THREAD_ID too to bind the topic to one forum topic of that chat.
 */
import { Bot } from "grammy";
import { Switchboard } from "grammy-switchboard";

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} (see the comment at the top of examples/ping/bot.ts)`);
    process.exit(1);
  }
  return value;
}

const token = env("BOT_TOKEN");
const chatId = Number(env("CHAT_ID"));
const threadId = process.env.THREAD_ID ? Number(process.env.THREAD_ID) : undefined;

// The bot is yours: install API transformers here (@grammyjs/auto-retry is recommended).
const bot = new Bot(token);

const switchboard = new Switchboard({
  api: bot.api,
  topics: { ops: { chatId, messageThreadId: threadId } },
  commands: { ops: [{ command: "ping", description: "Check that the bot is listening" }] },
  // Any object with info, warn and error fits; console does.
  logger: console,
});

const buttons = [
  [
    { label: "Again", action: "again" },
    { label: "Done", action: "done" },
  ],
];

switchboard.on("command", async (event) => {
  if (event.command !== "ping") return;
  await switchboard.send({
    topic: event.topic,
    text: `**Pong**, ${event.from?.name ?? "whoever you are"}.`,
    format: "markdown",
    replyTo: event.messageId,
    // The ref names the conversation; every press of these buttons carries it back.
    ref: `ping-${event.messageId}`,
    buttons,
  });
});

switchboard.on("button", async (event) => {
  if (event.messageId === undefined) return;
  const by = event.from?.name ?? "someone";
  if (event.action === "again") {
    await switchboard.edit({
      topic: event.topic,
      messageId: event.messageId,
      text: `**Pong** again, for ${by} at ${new Date().toISOString().slice(11, 19)} UTC.`,
      format: "markdown",
      // Without a store the message's ref isn't kept, so new buttons are given it again.
      ref: event.ref ?? undefined,
      buttons,
    });
  } else if (event.action === "done") {
    // Editing the keyboard away is how a button ends: it never expires on its own.
    await switchboard.edit({
      topic: event.topic,
      messageId: event.messageId,
      text: `Done (${event.ref}), closed by ${by}.`,
      buttons: [],
    });
  }
});

bot.use(switchboard);

// Anything the switchboard doesn't take reaches your own handlers.
bot.on("message", (ctx) =>
  console.log(`passed on by the switchboard: message ${ctx.message.message_id}`),
);

bot.catch((error) => console.error("handler failed:", error.error));

await bot.start({
  onStart: async (me) => {
    console.log(`@${me.username} is running; send /ping in the topic`);
    await switchboard.registerCommandMenus();
  },
});
