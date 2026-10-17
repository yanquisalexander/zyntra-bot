import { AsyncLocalStorage } from "node:async_hooks";
import { format, inspect } from "node:util";
import { logger } from "./logger.js";

/**
 * Puente console.* -> logger del panel.
 *
 * Los plugins corren in-process, así que `console` es global y no se puede
 * parchear por módulo. En su lugar:
 * - `installConsoleBridge()` parchea `console.*` una vez: si hay un plugin
 *   activo en el contexto async actual, el mensaje va al logger como
 *   `plugin:<nombre>` (visible en /api/logs, SSE y panel). Si no, delega
 *   al `console` original sin cambios.
 * - `runWithPlugin()` marca el contexto (setup, handlers de eventos,
 *   comandos, teardown, top-level del import). AsyncLocalStorage propaga
 *   el contexto a través de awaits, así que handlers async concurrentes
 *   de distintos plugins se atribuyen correctamente.
 * - Guardia `routing`: logger.error() escribe en console.error (logger.ts),
 *   sin la guardia habría recursión infinita.
 */

export const pluginAsyncContext = new AsyncLocalStorage<{ name: string }>();

export function runWithPlugin<T>(name: string, fn: () => T): T {
  return pluginAsyncContext.run({ name }, fn);
}

let installed = false;
let routing = false;

type BridgeLevel = "info" | "warn" | "error";

function bridge(level: BridgeLevel, text: string, fallback: () => void): void {
  const ctx = pluginAsyncContext.getStore();
  if (!ctx || routing) {
    fallback();
    return;
  }
  routing = true;
  try {
    if (level === "error") logger.error(`plugin:${ctx.name}`, text);
    else if (level === "warn") logger.warn(`plugin:${ctx.name}`, text);
    else logger.info(`plugin:${ctx.name}`, text);
  } finally {
    routing = false;
  }
}

export function installConsoleBridge(): void {
  if (installed) return;
  installed = true;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    trace: console.trace.bind(console),
    dir: console.dir.bind(console),
  };

  console.log = (...args: unknown[]) => {
    bridge("info", format(...args), () => orig.log(...args));
  };
  console.info = (...args: unknown[]) => {
    bridge("info", format(...args), () => orig.info(...args));
  };
  // El logger no tiene nivel debug: se degrada a info.
  console.debug = (...args: unknown[]) => {
    bridge("info", format(...args), () => orig.debug(...args));
  };
  console.warn = (...args: unknown[]) => {
    bridge("warn", format(...args), () => orig.warn(...args));
  };
  console.error = (...args: unknown[]) => {
    bridge("error", format(...args), () => orig.error(...args));
  };
  console.trace = (...args: unknown[]) => {
    const stack = (new Error().stack ?? "").split("\n").slice(2).join("\n");
    const text = `trace: ${format(...args)}${stack ? `\n${stack}` : ""}`;
    bridge("warn", text, () => orig.trace(...args));
  };
  console.dir = (obj: unknown, opts?: unknown) => {
    bridge("info", inspect(obj, opts as never), () => orig.dir(obj, opts as never));
  };
}
