export type LogLevel = "info" | "warn" | "error";
export interface LogEntry {
  ts: string;
  level: LogLevel;
  source: string; // "server" | "bot" | `plugin:<name>`
  message: string;
  meta?: unknown;
}

const MAX = 1000;
const buffer: LogEntry[] = [];
const listeners = new Set<(e: LogEntry) => void>();

// Lazy DB writer: no bloquea el loop; si no hay DB, solo memoria.
async function persist(entry: LogEntry) {
  try {
    const { getDb } = await import("../db/client.js");
    const { logs } = await import("../db/schema.js");
    await getDb().insert(logs).values({
      level: entry.level,
      source: entry.source,
      pluginName: entry.source.startsWith("plugin:")
        ? entry.source.slice(7)
        : null,
      message: entry.message.slice(0, 4000),
      meta: (entry.meta ?? null) as never,
    });
  } catch {
    /* DB opcional en runtime */
  }
}

export function log(level: LogLevel, source: string, message: string, meta?: unknown) {
  const entry: LogEntry = { ts: new Date().toISOString(), level, source, message, meta };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* noop */
    }
  }
  if (level === "error") console.error(`[${source}]`, message);
  void persist(entry);
}

export const logger = {
  info: (s: string, m: string, meta?: unknown) => log("info", s, m, meta),
  warn: (s: string, m: string, meta?: unknown) => log("warn", s, m, meta),
  error: (s: string, m: string, meta?: unknown) => log("error", s, m, meta),
};

export function getLogs(since?: string, limit = 200): LogEntry[] {
  const list = since ? buffer.filter((e) => e.ts > since) : buffer;
  return list.slice(-limit);
}
export function onLog(fn: (e: LogEntry) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
