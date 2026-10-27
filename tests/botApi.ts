import { Bot, type RawApi } from "grammy";
import { type UserFromGetMe } from "grammy/types";
import { type Mock, vi } from "vitest";
import { type Logger } from "../src/logger.js";

export const BOT_TOKEN = "123456:test-token";

/** Set on every stub bot, so handling an update never calls getMe. */
export const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "TestBot",
  username: "TestBot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  can_manage_bots: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  supports_join_request_queries: false,
};

/** What a stubbed method resolves to for the Bot API to answer with an error (a GrammyError). */
export class ApiFailure {
  readonly error_code: number;
  readonly description: string;

  constructor(error_code: number, description: string) {
    this.error_code = error_code;
    this.description = description;
  }
}

/** A logger whose every method is a mock. */
export function mockLogger() {
  return {
    info: vi.fn<Logger["info"]>(),
    warn: vi.fn<Logger["warn"]>(),
    error: vi.fn<Logger["error"]>(),
  };
}

export type ApiMethod = Mock<(payload: Record<string, unknown>) => unknown>;

/**
 * A real grammY `Bot` whose Bot API calls never leave the process: an API transformer hands each
 * call's payload to `telegram[method]` (one per Bot API method), a mock resolving to the method's result (`true` unless
 * given in `results` or set on the mock), and answers with it. A mock that resolves to an
 * `ApiFailure` makes grammY throw the GrammyError Telegram's error would; one that rejects throws
 * as a failed request would.
 */
export function stubBot(results: Record<string, unknown> = {}) {
  const bot = new Bot(BOT_TOKEN, { botInfo: BOT_INFO });
  const methods = new Map<string, ApiMethod>();
  const method = (name: string): ApiMethod => {
    let mock = methods.get(name);
    if (!mock) {
      mock = vi.fn<(payload: Record<string, unknown>) => unknown>();
      mock.mockResolvedValue(name in results ? results[name] : true);
      methods.set(name, mock);
    }
    return mock;
  };
  for (const name of Object.keys(results)) {
    method(name);
  }

  bot.api.config.use(async (_prev, name, payload) => {
    const result = await method(name)(payload as Record<string, unknown>);
    if (result instanceof ApiFailure) {
      return { ok: false, error_code: result.error_code, description: result.description };
    }
    // The transformer's return type is the method's own response; the mock's result stands in.
    return { ok: true, result } as never;
  });

  const telegram = new Proxy({} as Record<keyof RawApi, ApiMethod>, {
    get: (_target, name: string) => method(name),
  });
  return { bot, api: bot.api, telegram };
}
