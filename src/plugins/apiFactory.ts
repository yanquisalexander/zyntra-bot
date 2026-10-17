import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Client } from "discord.js";
import type { CommandCtx, HttpCtx, HttpMethod, JobOpts, PluginApi, UiIcon, UiTabDef, UiWidget, VarValue } from "./types.js";
import type { VarDef } from "./vars.js";
import { varsAll, varsGet, varsHas, varsIncr, varsReset, varsSet } from "./vars.js";
import { logger } from "./logger.js";
import { runWithPlugin } from "./consoleBridge.js";
import { DEFAULT_JOB_TIMEOUT_MS, type JobScheduler } from "./jobs.js";
import type { UiRegistry } from "./uiRegistry.js";
import type { PluginRegistry } from "./registry.js";

const UI_ID_RE = /^[A-Za-z0-9-_]{1,48}$/;
const UI_ICONS: UiIcon[] = ["chart", "table", "video", "bell", "clock", "list", "info", "zap", "puzzle"];
const UI_MIN_REFRESH_MS = 5000;
const UI_MAX_REFRESH_MS = 3600000;

const JOB_NAME_RE = /^[A-Za-z0-9-_]{1,48}$/;
const BUS_EVENT_RE = /^[A-Za-z0-9-_]{1,48}$/;
const BUS_PLUGIN_RE = /^[A-Za-z0-9-_]{1,32}$/;
const HTTP_PATH_RE = /^[A-Za-z0-9-_]+(?:\/[A-Za-z0-9-_]+)*$/;
const MAX_HTTP_ROUTES = 8;
const MAX_HTTP_PATH_LEN = 64;
/** Hosts permitidos para `api.lib.importUrl` (pinning + caché en disco). */
const LIB_ALLOWED_HOSTS = new Set(["esm.sh", "cdn.jsdelivr.net"]);
/** Nombres npm válidos para `api.lib.pkg` (sin rutas, URLs ni escapes). */
const LIB_PKG_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*|[a-z0-9-~][a-z0-9-._~]*)$/;
/** Módulos locales ya resueltos (compartidos entre plugins y recargas). */
const localPkgCache = new Map<string, Promise<unknown>>();
const LIB_MAX_BYTES = 5 * 1024 * 1024;
const LIB_FETCH_TIMEOUT_MS = 15_000;
/** Exige versión exacta (`paquete@1.2.3`) para evitar deriva silenciosa del CDN. */
const LIB_PINNED_RE = /@\d+\.\d+\.\d+(?:[-+][^/?#]*)?(?:[/?#]|$)/;
const MIN_INTERVAL_MS = 10_000;
const MIN_DELAY_MS = 5_000;
const MAX_DELAY_MS = 30 * 24 * 3600 * 1000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 300_000;

/** Valida lo estructural (lanza: falla el setup, visible en el panel). */
function checkedJob(
  plugin: string,
  job: string,
  handler: unknown,
  opts?: JobOpts,
): { description?: string; timeoutMs: number } {
  void plugin;
  if (typeof job !== "string" || !JOB_NAME_RE.test(job)) {
    throw new Error(`nombre de tarea inválido: "${String(job)}" (a-z, 0-9, -, _; máx 48)`);
  }
  if (typeof handler !== "function") throw new Error(`tarea "${job}": handler no es función`);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  if (!(timeoutMs >= MIN_TIMEOUT_MS) || !(timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new Error(`timeout fuera de rango (5s–5min): ${String(opts?.timeoutMs)}`);
  }
  return { description: opts?.description, timeoutMs };
}

/** Valida una pestaña declarativa (lanza: falla el setup, visible en el panel). */
function checkedTab(tab: UiTabDef): UiTabDef {
  if (!tab || typeof tab !== "object") throw new Error("ui.registerTab: definición requerida");
  if (!UI_ID_RE.test(tab.id ?? "")) throw new Error(`ui.registerTab id inválido: "${tab.id}"`);
  if (typeof tab.label !== "string" || !tab.label.trim() || tab.label.length > 48) {
    throw new Error(`ui.registerTab "${tab.id}": label requerido (máx 48)`);
  }
  const out: UiTabDef = { id: tab.id, label: tab.label.trim() };
  if (tab.icon !== undefined) {
    if (!UI_ICONS.includes(tab.icon)) {
      throw new Error(`ui.registerTab "${tab.id}": icon debe ser ${UI_ICONS.join("|")}`);
    }
    out.icon = tab.icon;
  }
  if (tab.description !== undefined) {
    if (typeof tab.description !== "string" || tab.description.length > 140) {
      throw new Error(`ui.registerTab "${tab.id}": description máx 140`);
    }
    out.description = tab.description;
  }
  return out;
}

/** Valida un widget declarativo (lanza: falla el setup, visible en el panel). */
function checkedWidget(widget: UiWidget): UiWidget {
  if (!widget || typeof widget !== "object") throw new Error("ui.widget: definición requerida");
  const kinds = ["stat", "table", "list", "line", "bars", "text", "actions"] as const;
  if (!kinds.includes(widget.kind as (typeof kinds)[number])) {
    throw new Error(`ui.widget: kind debe ser ${kinds.join("|")}`);
  }
  if (!UI_ID_RE.test(widget.id ?? "")) throw new Error(`ui.widget id inválido: "${widget.id}"`);
  if (widget.refreshMs !== undefined) {
    if (typeof widget.refreshMs !== "number" || !(widget.refreshMs >= UI_MIN_REFRESH_MS) || !(widget.refreshMs <= UI_MAX_REFRESH_MS)) {
      throw new Error(`ui.widget "${widget.id}": refreshMs entre 5000 y 3600000`);
    }
  }
  if (widget.width !== undefined && widget.width !== "full" && widget.width !== "half") {
    throw new Error(`ui.widget "${widget.id}": width debe ser full|half`);
  }
  if (widget.title !== undefined && (typeof widget.title !== "string" || widget.title.length > 60)) {
    throw new Error(`ui.widget "${widget.id}": title máx 60`);
  }
  switch (widget.kind) {
    case "stat":
      if (typeof widget.data !== "string" || !widget.data) throw new Error(`ui.widget "${widget.id}": data requerido`);
      if (widget.suffix !== undefined && typeof widget.suffix !== "string") throw new Error(`ui.widget "${widget.id}": suffix debe ser texto`);
      break;
    case "table": {
      if (typeof widget.data !== "string" || !widget.data) throw new Error(`ui.widget "${widget.id}": data requerido`);
      if (!Array.isArray(widget.columns) || widget.columns.length < 1 || widget.columns.length > 8) {
        throw new Error(`ui.widget "${widget.id}": columns 1–8 requeridas`);
      }
      for (const c of widget.columns) {
        if (!c || typeof c.key !== "string" || !c.key || typeof c.label !== "string" || !c.label) {
          throw new Error(`ui.widget "${widget.id}": cada columna necesita key+label`);
        }
      }
      break;
    }
    case "list":
    case "line":
    case "bars":
    case "text":
      if (typeof widget.data !== "string" || !widget.data) throw new Error(`ui.widget "${widget.id}": data requerido`);
      break;
    case "actions":
      if (!Array.isArray(widget.items) || widget.items.length < 1 || widget.items.length > 8) {
        throw new Error(`ui.widget "${widget.id}": items 1–8 requeridos`);
      }
      for (const id of widget.items) {
        if (!UI_ID_RE.test(id ?? "")) throw new Error(`ui.widget "${widget.id}": action id inválido "${id}"`);
      }
      break;
  }
  return widget;
}

/** Envuelve el handler con atribución al plugin y tracking de timers. */
function jobInput(
  plugin: string,
  handler: () => unknown,
  opts: JobOpts | undefined,
  registry: PluginRegistry,
): {
  description?: string;
  timeoutMs: number;
  fn: () => unknown;
  onTimer: (t: NodeJS.Timeout) => void;
} {
  return {
    description: opts?.description,
    timeoutMs: opts?.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
    fn: () => runWithPlugin(plugin, () => handler()),
    onTimer: (t) => {
      registry.timers.add(t);
    },
  };
}

/** Normaliza y valida una subruta de `api.http` (sin slashes externos). */
function normalizeHttpPath(input: unknown): string {
  const s = String(input ?? "").replace(/^\/+|\/+$/g, "");
  if (!s || s.length > MAX_HTTP_PATH_LEN || !HTTP_PATH_RE.test(s)) {
    throw new Error(`ruta http inválida: "${String(input)}" (a-z, 0-9, -, _, /; máx 64)`);
  }
  return s;
}

/** Registra una ruta HTTP del plugin (el router la sirve en `/plugin-routes/<plugin>/<path>`). */
function registerRoute(
  plugin: string,
  registry: import("./registry.js").PluginRegistry,
  method: HttpMethod,
  httpPath: unknown,
  handler: unknown,
  opts?: { raw?: boolean },
): void {
  const p = normalizeHttpPath(httpPath);
  if (typeof handler !== "function") throw new Error(`http ${method} "${p}": handler no es función`);
  const key = `${method} ${p}`;
  if (registry.routes.has(key)) {
    // Re-registro idempotente (mismo handler tras reload parcial): silencio.
    logger.warn(`plugin:${plugin}`, `http ${method} /${p} sobrescrita (evita duplicados)`);
  } else if (registry.routes.size >= MAX_HTTP_ROUTES) {
    throw new Error(`http: máximo ${MAX_HTTP_ROUTES} rutas por plugin`);
  }
  // Sin wrap aquí: el router invoca con runWithPlugin + timeout y propaga
  // el valor de retorno (el wrap de comandos tragaría la respuesta).
  registry.routes.set(key, {
    method,
    path: p,
    raw: opts?.raw === true,
    handler: handler as (ctx: never) => unknown,
  });
}

/** customId namespaced: `plugin:button:id` / `plugin:select:id` / `plugin:modal:id`. */
function normalizeComponentId(plugin: string, def: unknown, suffix: string): string {
  if (!def || typeof def !== "object") throw new Error("componente: definición requerida");
  const raw = String((def as { id?: unknown }).id ?? "");
  if (!UI_ID_RE.test(raw)) throw new Error(`componente id inválido: "${raw}" (a-z, 0-9, -, _; máx 48)`);
  if (!/^[a-z0-9-_]{1,32}$/.test(plugin)) throw new Error(`componente: plugin id inválido "${plugin}"`);
  return `${plugin}:${suffix}:${raw}`;
}

function registerComponent<T extends { type: number; custom_id: string }>(
  plugin: string,
  registry: import("./registry.js").PluginRegistry,
  suffix: "button" | "select" | "modal",
  def: unknown,
  handler: unknown,
): T {
  if (typeof handler !== "function") throw new Error(`componente ${suffix}: handler no es función`);
  const customId = normalizeComponentId(plugin, def, suffix);
  if (registry.components.has(customId))
    logger.warn(`plugin:${plugin}`, `componente ${suffix} "${customId}" sobrescrito (evita duplicados)`);
  registry.components.set(customId, { customId, handler: handler as (ctx: never) => unknown });
  const base = def as Record<string, unknown>;
  const label = typeof base.label === "string" ? base.label.trim().slice(0, 80) : undefined;
  if (suffix === "button") {
    const styleMap: Record<string, number> = { primary: 1, secondary: 2, success: 3, danger: 4 };
    const style = styleMap[String(base.style ?? "secondary")] ?? 2;
    return { type: 1, style, label, custom_id: customId } as unknown as T;
  }
  if (suffix === "select") {
    const options = Array.isArray(base.options) ? base.options.slice(0, 25) : [];
    const placeholder = typeof base.placeholder === "string" ? base.placeholder.trim().slice(0, 100) : undefined;
    return { type: 3, custom_id: customId, placeholder, options } as unknown as T;
  }
  // modal
  const title = typeof base.label === "string" ? base.label.trim().slice(0, 45) : undefined;
  const components = Array.isArray(base.components) ? base.components.slice(0, 5) : [];
  return { type: 9, custom_id: customId, title, components } as unknown as T;
}

/** Caché en disco para `api.lib.importUrl` (sobrevive reinicios y offline). */
function libCacheFile(url: string): { file: string; meta: string } {
  const dir = path.resolve(process.cwd(), "data/.cache/esm");
  const hash = crypto.createHash("sha256").update(url).digest("hex");
  return { file: path.join(dir, `${hash}.mjs`), meta: path.join(dir, `${hash}.json`), };
}

function checkedLibUrl(input: unknown): URL {
  if (typeof input !== "string" || !input.startsWith("https://")) {
    throw new Error(`importUrl: solo https de hosts permitidos (${[...LIB_ALLOWED_HOSTS].join(", ")})`);
  }
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error(`importUrl: URL inválida "${String(input).slice(0, 120)}"`);
  }
  if (!LIB_ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error(`importUrl: host no permitido "${u.hostname}" (usa ${[...LIB_ALLOWED_HOSTS].join(", ")})`);
  }
  if (!LIB_PINNED_RE.test(u.pathname + u.search + u.hash)) {
    throw new Error("importUrl: pinea la versión exacta (paquete@1.2.3) para evitar deriva del CDN");
  }
  if (u.hostname === "esm.sh" && !u.search.includes("bundle")) {
    throw new Error('importUrl: en esm.sh usa "?bundle&target=node" (un solo fichero autocontenido)');
  }
  return u;
}

function parseInterval(input: string | number): number {
  if (typeof input === "number") return input;
  const m = String(input)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!m) throw new Error(`intervalo inválido: "${input}" (usa "30s", "5m", "2h", "1d" o ms)`);
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return Number(m[1]) * (mult[m[2].toLowerCase()] ?? NaN);
}

/** Extrae el guildId del primer argumento que lo traiga (best-effort por evento).
 * null = sin servidor (DMs, ready…) → siempre pasa. */
function eventGuildId(args: unknown[]): string | null {
  for (const a of args) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    if (typeof o.guildId === "string" || o.guildId === null) return o.guildId;
    const g = o.guild as { id?: unknown } | null | undefined;
    if (g && typeof g.id === "string") return g.id;
    const m = o.message as Record<string, unknown> | null | undefined;
    if (m && (typeof m.guildId === "string" || m.guildId === null)) return m.guildId;
  }
  return null;
}

export function createApi(opts: {
  name: string;
  client: Client;
  registry: PluginRegistry;
  scheduler: JobScheduler;
  config: Record<string, unknown>;
  botConfig: { prefix: string };
  /** Single server: si devuelve false para el guild del evento, se ignora. */
  isGuildAllowed?: (guildId: string | null) => boolean;
  /** Variables declaradas en schema.yml (null = sin schema). */
  varDefs: Map<string, VarDef> | null;
  uiRegistry: UiRegistry;
  /** Bus inter-plugin (el manager lo provee; el teardown retira oyentes). */
  bus: {
    on(plugin: string, fullEvent: string, handler: (...a: never[]) => unknown): void;
    off(plugin: string, fullEvent: string, handler?: (...a: never[]) => unknown): void;
    emit(source: string, name: string, ...args: unknown[]): Promise<void>;
  };
}): PluginApi {
  const { name, client, registry, scheduler, config, botConfig, isGuildAllowed, varDefs, uiRegistry, bus } = opts;

  /** `twitch:stream-started` → `{ source: "twitch", name: "stream-started" }`. */
  const parseBusEvent = (event: unknown): { source: string; name: string } => {
    if (typeof event !== "string" || !event.includes(":")) {
      throw new Error(`evento inválido: "${String(event)}" (usa "plugin:evento", p. ej. "twitch:stream-started")`);
    }
    const idx = event.indexOf(":");
    const source = event.slice(0, idx).toLowerCase();
    const evName = event.slice(idx + 1);
    if (!BUS_PLUGIN_RE.test(source) || !BUS_EVENT_RE.test(evName) || event.includes(":", idx + 1)) {
      throw new Error(`evento inválido: "${event}" (usa "plugin:evento", a-z, 0-9, -, _)`);
    }
    return { source, name: evName };
  };

  const wrap = (op: string, fn: () => unknown) => {
    try {
      // Ejecuta el handler en el contexto del plugin: los console.*
      // (también en awaits posteriores) se atribuyen a este plugin.
      const r = runWithPlugin(name, fn) as Promise<unknown> | unknown;
      if (r instanceof Promise)
        r.catch((e) => logger.error(`plugin:${name}`, `${op} failed: ${String(e?.stack ?? e)}`));
    } catch (e) {
      logger.error(`plugin:${name}`, `${op} failed: ${String((e as Error)?.stack ?? e)}`);
    }
  };

  return {
    name,
    config,
    botConfig,
    client,
    events: {
      on: (event, handler) => {
        // Con `:` es bus inter-plugin (`twitch:stream-started`); sin `:` es discord.js.
        if (typeof event === "string" && event.includes(":")) {
          const { source, name: evName } = parseBusEvent(event);
          if (typeof handler !== "function") throw new Error(`evento "${event}": handler no es función`);
          bus.on(name, `${source}:${evName}`, handler as (...a: never[]) => unknown);
          return;
        }
        const safe = (...a: never[]) => {
          // Single server: ignora eventos de otros servidores (DMs pasan).
          if (isGuildAllowed && !isGuildAllowed(eventGuildId(a as unknown[]))) return;
          wrap(`event ${event}`, () => handler(...a));
        };
        registry.listeners.push({ event, handler: safe });
        (client.on as (...args: unknown[]) => void)(event, safe);
      },
      off: (event, handler) => {
        if (typeof event === "string" && event.includes(":")) {
          const { source, name: evName } = parseBusEvent(event);
          bus.off(name, `${source}:${evName}`, handler as ((...a: never[]) => unknown) | undefined);
          return;
        }
        (client.off as (...args: unknown[]) => void)(event, handler as (...a: never[]) => void);
        registry.listeners = registry.listeners.filter((l) => l.handler !== handler);
      },
    },
    emit: async (eventName, ...args) => {
      if (typeof eventName !== "string" || !BUS_EVENT_RE.test(eventName)) {
        throw new Error(`evento inválido: "${String(eventName)}" (a-z, 0-9, -, _; máx 48)`);
      }
      // Namespace automático: siempre `<mi-plugin>:<evento>`.
      await bus.emit(name, eventName, ...args);
    },
    commands: {
      register: (cmd, handler, cmdOpts) => {
        if (typeof cmd !== "string" || !/^[A-Za-z0-9-_]{1,32}$/.test(cmd)) {
          throw new Error(`nombre de comando inválido: "${String(cmd)}" (a-z, 0-9, -, _; máx 32)`);
        }
        if (typeof handler !== "function") throw new Error(`comando "${cmd}": handler no es función`);
        const key = cmd.toLowerCase();
        if (registry.commands.has(key))
          logger.warn(`plugin:${name}`, `command !${key} sobrescrito (evita duplicados)`);
        const rawDesc = cmdOpts?.description;
        const description =
          typeof rawDesc === "string" && rawDesc.trim() ? rawDesc.trim().slice(0, 140) : undefined;
        // Slash: el handler se adapta a interactionCreate. Sin slash, el
        // !prefijo sigue funcionando solo.
        const slash = cmdOpts?.slash
          ? {
              description: String(cmdOpts.slash.description ?? description ?? key).slice(0, 100),
              options: Array.isArray(cmdOpts.slash.options) ? cmdOpts.slash.options.slice(0, 25) : [],
            }
          : undefined;
        registry.commands.set(key, {
          description,
          slash,
          handler: (ctx: never, ...a: string[]) =>
            wrap(`command !${key}`, () => handler(ctx as unknown as CommandCtx, ...a)),
        });
      },
      unregister: (cmd) => {
        registry.commands.delete(String(cmd).toLowerCase());
      },
    },
    http: {
      get: (httpPath, handler, httpOpts) => {
        registerRoute(name, registry, "GET", httpPath, handler, httpOpts);
      },
      post: (httpPath, handler, httpOpts) => {
        registerRoute(name, registry, "POST", httpPath, handler, httpOpts);
      },
      unregister: (httpPath) => {
        const p = normalizeHttpPath(httpPath);
        registry.routes.delete(`GET ${p}`);
        registry.routes.delete(`POST ${p}`);
      },
    },
    lib: {
      importUrl: async (url) => {
        const u = checkedLibUrl(url);
        const { file, meta } = libCacheFile(u.href);
        try {
          await fs.access(file);
          return await runWithPlugin(name, () => import(pathToFileURL(file).href));
        } catch {
          /* sin caché: descargar */
        }
        const download = async (target: URL): Promise<Uint8Array> => {
          let res: Response;
          try {
            res = await fetch(target.href, {
              signal: AbortSignal.timeout(LIB_FETCH_TIMEOUT_MS),
              headers: { "User-Agent": "zyntra-bot plugin-lib" },
            });
          } catch (e) {
            throw new Error(`importUrl: descarga falló (${String(e).split("\n")[0]})`);
          }
          if (!res.ok) throw new Error(`importUrl: HTTP ${res.status} para ${target.hostname}${target.pathname}`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.length === 0 || bytes.length > LIB_MAX_BYTES) {
            throw new Error(`importUrl: tamaño inesperado (${bytes.length} bytes, máx ${LIB_MAX_BYTES})`);
          }
          return bytes;
        };
        // esm.sh con `?bundle` responde un stub (`export * from "/...bundle.mjs"`):
        // se sigue (máx 3 saltos, mismo host permitido).
        let current = u;
        let buf = await download(current);
        for (let hop = 0; hop < 3; hop++) {
          const text = new TextDecoder().decode(buf);
          const stub = text.match(/^\s*(?:\/\*[\s\S]*?\*\/\s*)?export\s*\*\s*from\s*"([^"]+)"\s*;?\s*$/);
          if (!stub) break;
          current = new URL(stub[1], current.href);
          if (!LIB_ALLOWED_HOSTS.has(current.hostname)) {
            throw new Error(`importUrl: redirección a host no permitido "${current.hostname}"`);
          }
          buf = await download(current);
        }
        const finalText = new TextDecoder().decode(buf);
        // Solo bundles autocontenidos: con chunks (`from"/..."`, https o
        // imports desnudos) Node no puede resolverlos desde disco.
        if (/\bfrom\s*["'][^"']+["']/.test(finalText) || /import\(\s*["'][^"']+["']/.test(finalText)) {
          throw new Error(
            "importUrl: el bundle usa chunks/imports externos (no autocontenido). " +
            "Usa un paquete de un solo fichero o pide la dep como dependencia del host.",
          );
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, buf);
        await fs.writeFile(meta, JSON.stringify({ url: u.href, bytes: buf.length, at: new Date().toISOString() }), "utf8").catch(() => undefined);
        logger.info(`plugin:${name}`, `lib descargada: ${u.hostname}${u.pathname} (${buf.length}B, caché en disco)`);
        return await runWithPlugin(name, () => import(pathToFileURL(file).href));
      },
      pkg: async (pkgName) => {
        if (typeof pkgName !== "string" || !LIB_PKG_RE.test(pkgName)) {
          throw new Error(`pkg: nombre inválido "${String(pkgName).slice(0, 80)}" (solo paquetes npm del host)`);
        }
        let pending = localPkgCache.get(pkgName);
        if (!pending) {
          pending = import(pkgName).catch((e: unknown) => {
            localPkgCache.delete(pkgName);
            throw new Error(
              `pkg "${pkgName}" no instalado en el host (${String(e).split("\n")[0]}). Instálalo con pnpm add ${pkgName}`,
            );
          });
          localPkgCache.set(pkgName, pending);
        }
        return await runWithPlugin(name, () => pending as Promise<unknown>);
      },
    },
    jobs: {
      every: (job, interval, handler, jobOpts) => {
        const checked = checkedJob(name, job, handler, jobOpts);
        const intervalMs = parseInterval(interval);
        if (!(intervalMs >= MIN_INTERVAL_MS))
          throw new Error(`intervalo mínimo ${MIN_INTERVAL_MS / 1000}s (pedido: ${String(interval)})`);
        const s = scheduler.register({
          plugin: name,
          name: job,
          kind: "interval",
          expr: typeof interval === "number" ? `${interval}ms` : String(interval),
          intervalMs,
          ...jobInput(name, handler, checked, registry),
        });
        return s.id;
      },
      cron: (job, expr, handler, jobOpts) => {
        const checked = checkedJob(name, job, handler, jobOpts);
        if (typeof expr !== "string" || !expr.trim()) throw new Error("cron: expresión vacía");
        // Ojo: un cron mal formado NO lanza (se marca inválido en el panel).
        const s = scheduler.register({
          plugin: name,
          name: job,
          kind: "cron",
          expr: expr.trim(),
          cron: expr.trim(),
          ...jobInput(name, handler, checked, registry),
        });
        return s.id;
      },
      in: (job, delayMs, handler, jobOpts) => {
        const checked = checkedJob(name, job, handler, jobOpts);
        if (!(delayMs >= MIN_DELAY_MS) || !(delayMs <= MAX_DELAY_MS))
          throw new Error(`delay fuera de rango (5s–30d): ${String(delayMs)}`);
        const s = scheduler.register({
          plugin: name,
          name: job,
          kind: "once",
          expr: `en ${Math.round(delayMs / 1000)}s`,
          runAt: Date.now() + delayMs,
          ...jobInput(name, handler, checked, registry),
        });
        return s.id;
      },
      at: (job, date, handler, jobOpts) => {
        const checked = checkedJob(name, job, handler, jobOpts);
        const t = date instanceof Date ? date.getTime() : new Date(date).getTime();
        if (!Number.isFinite(t)) throw new Error(`fecha inválida: ${String(date)}`);
        if (t - Date.now() < MIN_DELAY_MS) throw new Error("la fecha tiene que ser futura (+5s)");
        const s = scheduler.register({
          plugin: name,
          name: job,
          kind: "once",
          expr: new Date(t).toLocaleString("es-ES"),
          runAt: t,
          ...jobInput(name, handler, checked, registry),
        });
        return s.id;
      },
      cancel: (id) => scheduler.cancel(id),
    },
    ui: {
      registerTab: (tab) => {
        uiRegistry.registerTab(name, checkedTab(tab));
      },
      unregisterTab: (id) => {
        uiRegistry.unregisterTab(name, id);
      },
      widget: (tabId, widget) => {
        if (!uiRegistry.hasTab(name, tabId)) {
          throw new Error(`ui.widget: tab "${tabId}" no registrada (api.ui.registerTab primero)`);
        }
        const prev = uiRegistry.hasWidget(name, tabId, widget.id);
        if (prev) logger.warn(`plugin:${name}`, `ui widget "${widget.id}" sobrescrito (evita duplicados)`);
        uiRegistry.registerWidget(name, tabId, checkedWidget(widget));
      },
      data: (id, provider) => {
        if (!UI_ID_RE.test(id)) throw new Error(`ui.data id inválido: "${id}" (a-z, 0-9, -, _; máx 48)`);
        if (typeof provider !== "function") throw new Error(`ui.data "${id}": provider no es función`);
        uiRegistry.registerData(name, id, () => runWithPlugin(name, () => provider()));
      },
      action: (def, handler) => {
        if (!def || typeof def !== "object") throw new Error("ui.action: definición requerida");
        if (!UI_ID_RE.test(def.id ?? "")) throw new Error(`ui.action id inválido: "${def.id}"`);
        if (typeof def.label !== "string" || !def.label.trim() || def.label.length > 48) {
          throw new Error(`ui.action "${def.id}": label requerido (máx 48)`);
        }
        const variant = def.variant ?? "default";
        if (variant !== "default" && variant !== "secondary" && variant !== "destructive") {
          throw new Error(`ui.action "${def.id}": variant debe ser default|secondary|destructive`);
        }
        if (typeof handler !== "function") throw new Error(`ui.action "${def.id}": handler no es función`);
        uiRegistry.registerAction(name, {
          id: def.id,
          label: def.label.trim(),
          variant,
          confirm: typeof def.confirm === "string" && def.confirm.trim() ? def.confirm.trim().slice(0, 140) : undefined,
          handler: (args) => runWithPlugin(name, () => handler(args)),
        });
      },
      unregisterAction: (id) => {
        uiRegistry.unregisterAction(name, id);
      },
    },
    vars: {
      get: (key, fallback) => varsGet(name, varDefs, key, fallback),
      set: (key, value) => varsSet(name, varDefs, key, value as VarValue),
      incr: (key, by = 1) => varsIncr(name, varDefs, key, by),
      decr: (key, by = 1) => varsIncr(name, varDefs, key, -by),
      reset: (key) => varsReset(name, varDefs, key),
      has: (key) => varsHas(name, varDefs, key),
      all: () => varsAll(name, varDefs),
    },
    sendMessage: async (channel: unknown, content: string) => {
      const ch = channel as { send?: (c: string) => Promise<unknown>; isSendable?: () => boolean } | null;
      if (!ch || typeof ch.send !== "function") throw new Error("canal no enviable (¿systemChannel null?)");
      return ch.send(content);
    },
    reply: async (message: unknown, content: string) => {
      const m = message as { reply?: (c: string) => Promise<unknown> };
      if (!m || typeof m.reply !== "function") throw new Error("reply requiere un Message");
      return m.reply(content);
    },
    sendEmbed: async (channel: unknown, embed: Record<string, unknown>) => {
      const ch = channel as { send?: (c: unknown) => Promise<unknown> } | null;
      if (!ch || typeof ch.send !== "function") throw new Error("canal no enviable");
      return ch.send({ embeds: [embed] });
    },
    log: {
      info: (m) => logger.info(`plugin:${name}`, m),
      warn: (m) => logger.warn(`plugin:${name}`, m),
      error: (m) => logger.error(`plugin:${name}`, m),
    },
    onCleanup: (fn) => {
      registry.cleanups.push(fn);
    },
    discord: {
      button: (def, handler) => registerComponent(name, registry, "button", def, handler),
      selectMenu: (def, handler) => registerComponent(name, registry, "select", def, handler),
      modal: (def, handler) => registerComponent(name, registry, "modal", def, handler),
      unregister: (id) => {
        for (const suffix of ["button", "select", "modal"]) {
          registry.components.delete(normalizeComponentId(name, { id }, suffix));
        }
      },
    },
  };
}
