/**
 * stderr-only JSON-lines logger. stdout belongs to the MCP transport; nothing in
 * this package may write there except the transport itself (and CLI verbs).
 */
export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  readonly level: LogLevel;
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v);
}

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LoggerOptions {
  level?: LogLevel;
  /** Test hook; defaults to `process.stderr.write`. */
  write?: (line: string) => void;
  now?: () => string;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? "warn";
  const write = opts.write ?? ((line: string) => void process.stderr.write(line));
  const now = opts.now ?? (() => new Date().toISOString());
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (RANK[lvl] > RANK[level]) return;
    write(`${JSON.stringify({ level: lvl, ts: now(), msg, ...fields })}\n`);
  };
  return {
    level,
    error: (m, f) => emit("error", m, f),
    warn: (m, f) => emit("warn", m, f),
    info: (m, f) => emit("info", m, f),
    debug: (m, f) => emit("debug", m, f),
  };
}

export const silentLogger: Logger = createLogger({ write: () => {} });
