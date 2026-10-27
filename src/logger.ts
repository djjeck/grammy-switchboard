/** Structured fields logged alongside a message. */
export type LogFields = Record<string, unknown>;

/**
 * Where the switchboard reports what it skipped or recovered from (an unknown button, a rejected
 * formatting, a command menu that failed). Injected, so the library never writes to the console
 * on its own; any logger with these three methods fits (pino, console, a custom JSON one).
 */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const ignore = (): void => {};

/** The default: logs nothing. */
export const silentLogger: Logger = { info: ignore, warn: ignore, error: ignore };
