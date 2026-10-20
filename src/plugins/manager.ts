import type { Client, Message } from "discord.js";
import { importFresh, syntaxCheck, validateDefinition } from "./loader.js";
import { runWithPlugin } from "./consoleBridge.js";
import { JobScheduler } from "./jobs.js";
import { UiRegistry } from "./uiRegistry.js";
import { createApi } from "./apiFactory.js";
import { PluginRegistry } from "./registry.js";
import { logger } from "./logger.js";
import {
  ensureDirs,
  isCore,
  listPluginNames,
  parseConfig,
  readConfigToml,
  readSchema,
} from "./store.js";
import { parseSchemaYaml } from "./schema.js";
import { varDefsFromSchema, type VarDef } from "./vars.js";
import type { PluginDefinition, PluginRecord, PluginStatus } from "./types.js";
import type { PluginMetricsDTO } from "./metrics.js";
import { pluginMetrics } from "./metrics.js";

interface Loaded {
  def: PluginDefinition;
  registry: PluginRegistry;
  config: Record<string, unknown>;
  version: string;
  description?: string;
  displayName: string;
  startupMs: number | null;
}

/** Nombre visible: `definePlugin({ name })`, o el ID de la carpeta. */
function displayNameOf(folder: string, def: PluginDefinition): string {
  const n = typeof def.name === "string" ? def.name.trim() : "";
  return n || folder;
}

/**
 * Variables declaradas (`type: variable` en schema.yml) o null si no hay
 * schema válido. Un schema roto no tumba la carga: vars falla con error claro.
 */
async function readVarDefs(name: string): Promise<Map<string, VarDef> | null> {
  try {
    const parsed = parseSchemaYaml(await readSchema(name));
    if (!parsed.ok || !parsed.schema) return null;
    return varDefsFromSchema(parsed.schema);
  } catch {
    return null;
  }
}

/**
 * PluginManager: descubre, carga, recarga y descarga plugins en runtime.
 * Errores aislados por plugin: ningún fallo tumba el bot.
 * Recarga idempotente con lock por plugin; ante fallo conserva la versión activa.
 */
export class PluginManager {
  private loaded = new Map<string, Loaded>();
  private status = new Map<string, PluginStatus>();
  private errors = new Map<string, string>();
  private loadedAt = new Map<string, string>();
  private enabled = new Map<string, boolean>();
  private locks = new Map<string, Promise<unknown>>();
  private corePlugins = new Set<string>();
  private _guildId = "";
  /** Bus inter-plugin: evento completo (`<plugin>:<evento>`) → suscriptores. */
  private bus = new Map<string, Set<{ plugin: string; handler: (...a: never[]) => unknown }>>();
  prefix = "!";
  /** Servidor único (guildId). Vacío = todos (comportamiento actual). */
  get guildId(): string {
    return this._guildId;
  }

  set guildId(value: string) {
    const next = value || "";
    if (next === this._guildId) return;
    this._guildId = next;
    if (next && this.client.isReady()) void this.registerAllSlashCommands();
  }
  readonly scheduler = new JobScheduler();
  readonly ui = new UiRegistry();

  /** Single server: fuera del servidor elegido no se responde. DMs (null) pasan. */
  isGuildAllowed(guildId: string | null): boolean {
    return !this.guildId || !guildId || guildId === this.guildId;
  }

  constructor(private client: Client) {
    // Dispatcher de comandos con prefijo (no bloquea el server HTTP).
    client.on("messageCreate", (msg: Message) => {
      void this.dispatchCommand(msg);
    });
    // Interacciones de Discord: slash commands, botones, selects, modales.
    client.on("interactionCreate", (interaction) => {
      void this.dispatchInteraction(interaction as never);
    });
    // El autoload puede terminar antes de que Discord esté listo. Reintenta
    // publicar los comandos cuando la conexión ya puede usar la REST API.
    client.on("ready", () => {
      void this.registerAllSlashCommands();
    });
  }

  private async dispatchCommand(msg: Message) {
    if (msg.author.bot || !msg.content.startsWith(this.prefix)) return;
    if (!this.isGuildAllowed(msg.guildId)) return;
    const [raw, ...args] = msg.content.slice(this.prefix.length).trim().split(/\s+/);
    const name = raw.toLowerCase();
    for (const [plugin, l] of this.loaded) {
      const entry = l.registry.commands.get(name);
      if (!entry) continue;
      const c0 = Date.now();
      let ok = true;
      try {
        await entry.handler(
          { message: msg, content: msg.content, args } as never,
          ...args,
        );
      } catch (e) {
        ok = false;
        logger.error(`plugin:${plugin}`, `command !${name}: ${String(e)}`);
      } finally {
        pluginMetrics.command(plugin, Date.now() - c0, ok);
      }
      return; // primer registro gana
    }
  }

  /** Aplica opciones de slash a Discord: choices numéricos, min/max, required. */
  private static toDiscordOptions(opts: unknown[]): Record<string, unknown>[] {
    const TYPE: Record<string, number> = { string: 3, number: 4, boolean: 5, user: 6, channel: 7, role: 8 };
    return (opts ?? [])
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
      .map((o) => {
        const out: Record<string, unknown> = {
          name: String(o.name ?? ""),
          type: TYPE[String(o.type ?? "string")] ?? 3,
          description: typeof o.description === "string" ? o.description.slice(0, 100) : undefined,
          required: o.required === true,
        };
        if (Array.isArray(o.choices)) out.choices = o.choices;
        if (typeof o.min_value === "number") out.min_value = o.min_value;
        if (typeof o.max_value === "number") out.max_value = o.max_value;
        return out;
      });
  }

  /**
   * Registra los slash commands de un plugin en el guild (REST de Discord).
   * Guild-scoped: instantáneo (global tarda hasta 1h). Sin guildId o sin
   * cliente listo, se omite (el comando !nombre sigue funcionando).
   */
  async registerSlashCommands(plugin: string): Promise<void> {
    const l = this.loaded.get(plugin);
    if (!l) return;
    const winners = this.commandWinners();
    const entries = [...l.registry.commands.entries()].filter(([name, e]) => e.slash && winners.get(name) === plugin);
    if (entries.length === 0) return;
    if (!this.guildId || !this.client.isReady() || !this.client.user) return;
    const url = `https://discord.com/api/v10/applications/${this.client.user.id}/guilds/${this.guildId}/commands`;
    for (const [name, entry] of entries) {
      const body = {
        name,
        description: (entry.slash?.description ?? entry.description ?? name).slice(0, 100),
        options: PluginManager.toDiscordOptions(entry.slash?.options as unknown[]),
      };
      try {
        const res = await fetch(url, {
          // POST crea o actualiza este comando por nombre. PUT reemplaza la
          // lista completa del guild, así que no debe usarse por comando.
          method: "POST",
          headers: { Authorization: `Bot ${this.client.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          logger.warn(`plugin:${plugin}`, `slash /${name}: HTTP ${res.status} ${txt.slice(0, 120)}`);
          continue;
        }
        const created = (await res.json()) as { id?: string };
        if (created.id) entry.discordId = created.id;
        logger.info(`plugin:${plugin}`, `slash /${name} registrado`);
      } catch (e) {
        logger.warn(`plugin:${plugin}`, `slash /${name}: ${String(e).split("\n")[0]}`);
      }
    }
  }

  private async registerAllSlashCommands(): Promise<void> {
    if (!this.client.isReady() || !this.client.user) return;
    if (!this.guildId) {
      const hasSlashCommands = [...this.loaded.values()].some((plugin) =>
        [...plugin.registry.commands.values()].some((command) => !!command.slash),
      );
      if (hasSlashCommands) logger.warn("bot", "slash commands pendientes: elige el servidor del bot en Configuración");
      return;
    }
    for (const plugin of this.loaded.keys()) {
      await this.registerSlashCommands(plugin);
    }
  }

  private async dispatchInteraction(interaction: never) {
    if (!this.client.user) return;

    const raw = interaction as Record<string, unknown>;

    // ── 1. Componentes: botones, selects (string/user/role/channel/mentionable), modales ──
    const isComponent =
      (raw.isButton as (() => boolean) | undefined)?.() ||
      // discord.js v14: isSelectMenu() deprecated → usar los tipos específicos
      (raw.isStringSelectMenu as (() => boolean) | undefined)?.() ||
      (raw.isUserSelectMenu as (() => boolean) | undefined)?.() ||
      (raw.isRoleSelectMenu as (() => boolean) | undefined)?.() ||
      (raw.isChannelSelectMenu as (() => boolean) | undefined)?.() ||
      (raw.isMentionableSelectMenu as (() => boolean) | undefined)?.() ||
      (raw.isModalSubmit as (() => boolean) | undefined)?.();

    if (isComponent) {
      const customId = String(raw.customId ?? "");
      // Single-server: los componentes también se filtran por guild.
      const guildId = raw.guildId != null ? String(raw.guildId) : null;
      if (this.isGuildAllowed && !this.isGuildAllowed(guildId)) return;

      for (const [plugin, l] of this.loaded) {
        const comp = l.registry.components.get(customId);
        if (!comp) continue;
        try {
          await comp.handler({
            interaction,
            customId,
            // values: string[] para selects, vacío para botones/modales.
            values: Array.isArray(raw.values) ? (raw.values as string[]) : [],
            user: raw.user,
            channel: raw.channel ?? null,
            guild: raw.guild ?? null,
            reply: (c: unknown) =>
              (raw.reply as (c: unknown) => Promise<unknown>)(
                typeof c === "string" ? { content: c } : c,
              ),
            deferReply: (opts?: unknown) =>
              (raw.deferReply as (o?: unknown) => Promise<unknown>)(opts),
            editReply: (c: unknown) =>
              (raw.editReply as (c: unknown) => Promise<unknown>)(
                typeof c === "string" ? { content: c } : c,
              ),
            // showModal: solo válido desde botón/select (discord.js lo valida).
            // discord.js espera { customId, title, components } (camelCase).
            // api.discord.modal() devuelve { custom_id, title, components } → traducir.
            showModal: (m: unknown) => {
              const obj = m as Record<string, unknown>;
              return (raw.showModal as (m: unknown) => Promise<unknown>)({
                customId: obj.customId ?? obj.custom_id,
                title: obj.title,
                components: obj.components,
              });
            },
          } as never);
        } catch (e) {
          logger.error(`plugin:${plugin}`, `component ${customId}: ${String(e)}`);
        }
        return;
      }
      return;
    }

    // ── 2. Slash commands (ChatInput) ─────────────────────────────────────
    if (!(raw.isChatInputCommand as (() => boolean) | undefined)?.()) return;

    const guildId = raw.guildId != null ? String(raw.guildId) : null;
    if (this.isGuildAllowed && !this.isGuildAllowed(guildId)) return;

    const cmdName = String(raw.commandName ?? "").toLowerCase();
    const opts = raw.options as Record<string, unknown> | undefined;

    for (const [plugin, l] of this.loaded) {
      const entry = l.registry.commands.get(cmdName);
      if (!entry?.slash) continue;

      // Reconstruye args[] en el mismo orden que las options declaradas.
      const args: string[] = [];
      for (const opt of (entry.slash.options ?? []) as Record<string, unknown>[]) {
        const optName = String(opt.name ?? "");
        const t = String(opt.type ?? "string");
        let val: unknown;
        if (t === "user") {
          val = (opts?.getUser as ((n: string) => { id: string } | null | undefined) | undefined)?.(optName)?.id;
        } else if (t === "number") {
          val = (opts?.getNumber as ((n: string) => number | null) | undefined)?.(optName) ??
                (opts?.getInteger as ((n: string) => number | null) | undefined)?.(optName);
        } else if (t === "boolean") {
          val = (opts?.getBoolean as ((n: string) => boolean | null) | undefined)?.(optName);
        } else if (t === "channel") {
          val = (opts?.getChannel as ((n: string) => { id: string } | null | undefined) | undefined)?.(optName)?.id;
        } else if (t === "role") {
          val = (opts?.getRole as ((n: string) => { id: string } | null | undefined) | undefined)?.(optName)?.id;
        } else {
          val = (opts?.getString as ((n: string) => string | null) | undefined)?.(optName);
        }
        if (val !== null && val !== undefined) args.push(String(val));
      }

      const c0 = Date.now();
      let ok = true;
      try {
        // Para slash, message es null. El handler puede detectarlo y usar
        // ctx.replyInteraction() para responder via la interaction.
        await entry.handler(
          {
            message: null as never,
            content: `/${cmdName}${args.length ? " " + args.join(" ") : ""}`,
            args,
            // Helper extra: responde vía la interaction de slash (ephemeral opt-in).
            replyInteraction: (c: unknown, ephemeral = false) =>
              (raw.reply as (c: unknown) => Promise<unknown>)(
                typeof c === "string" ? { content: c, ephemeral } : { ephemeral, ...(c as object) },
              ),
            deferInteraction: (ephemeral = false) =>
              (raw.deferReply as (o: unknown) => Promise<unknown>)({ ephemeral }),
            editInteraction: (c: unknown) =>
              (raw.editReply as (c: unknown) => Promise<unknown>)(
                typeof c === "string" ? { content: c } : c,
              ),
            isSlash: true,
            interaction: raw,
          } as never,
          ...args,
        );
      } catch (e) {
        ok = false;
        logger.error(`plugin:${plugin}`, `slash /${cmdName}: ${String(e)}`);
      } finally {
        pluginMetrics.slash(plugin, Date.now() - c0, ok);
      }
      return;
    }
  }

  private withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn) as Promise<T>;
    this.locks.set(name, next.catch(() => undefined));
    return next;
  }

  async discover(): Promise<void> {
    await ensureDirs();
    const names = await listPluginNames();
    for (const n of names) {
      if (!this.enabled.has(n)) this.enabled.set(n, true);
      if (!this.status.has(n)) this.status.set(n, "disabled");
      // Caché de core (isCore es async; list/getStatus son sync).
      if (await isCore(n)) this.corePlugins.add(n);
      else this.corePlugins.delete(n);
    }
  }

  /**
   * Hidrata enabled/status desde la DB antes del autoload, así un plugin
   * apagado sobrevive al reinicio (discover() no lo vuelve a encender).
   */
  async hydrateState(): Promise<void> {
    try {
      const { getDb } = await import("../db/client.js");
      const { plugins } = await import("../db/schema.js");
      const db = getDb();
      const rows = await db.select().from(plugins);
      for (const r of rows) {
        this.enabled.set(r.name, r.enabled === true);
        // `status` describes a live runtime and is stale after a process
        // restart. Restore only the desired enabled state; autoload will set
        // loading/active/error based on this process's actual result.
        this.status.set(r.name, "disabled");
      }
    } catch {
      /* DB opcional */
    }
  }

  async autoload() {
    await this.discover();
    for (const [name, en] of this.enabled) {
      // El estado "active" de la DB pertenece al proceso anterior. Solo la
      // presencia en `loaded` confirma que el plugin está cargado en esta
      // instancia; tras reiniciar el proceso siempre hay que volver a cargarlo.
      if (en && !this.loaded.has(name)) {
        await this.load(name).catch(() => undefined);
      }
    }
  }

  async load(name: string): Promise<void> {
    return this.withLock(name, async () => {
      this.status.set(name, "loading");
      this.errors.delete(name);
      try {
        const toml = await readConfigToml(name);
        const config = parseConfig(toml);
        const check = await syntaxCheck(name);
        if (!check.ok) throw new Error(`syntax: ${check.error}`);
        const def = (await importFresh(name)) as PluginDefinition;
        const err = validateDefinition(def);
        if (err) throw new Error(err);
        const registry = new PluginRegistry();
        const api = createApi({
          name,
          client: this.client,
          registry,
          scheduler: this.scheduler,
          config,
          botConfig: { prefix: this.prefix },
          isGuildAllowed: (g) => this.isGuildAllowed(g),
          varDefs: await readVarDefs(name),
          uiRegistry: this.ui,
          bus: {
            on: (plugin, fullEvent, handler) => this.onBus(plugin, fullEvent, handler),
            off: (plugin, fullEvent, handler) => this.offBus(plugin, fullEvent, handler),
            emit: (source, evName, ...args) => this.emitBus(source, evName, ...args),
          },
        });
        const t0 = Date.now();
        const setup = runWithPlugin(name, () => def.setup(api));
        if (setup instanceof Promise) {
          await Promise.race([
            setup,
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error("setup timeout (10s)")), 10_000),
            ),
          ]);
        }
        const startupMs = Date.now() - t0;
        pluginMetrics.startup(name, startupMs);
        this.loaded.set(name, {
          def,
          registry,
          config,
          version: def.version ?? "0.1.0",
          description: def.description,
          displayName: displayNameOf(name, def),
          startupMs,
        });
        this.status.set(name, "active");
        this.errors.delete(name);
        this.loadedAt.set(name, new Date().toISOString());
        logger.info(`plugin:${name}`, `cargado v${def.version ?? "0.1.0"}`);
        this.warnCommandConflicts(name);
        await this.registerSlashCommands(name).catch(() => undefined);
        void this.persistMeta(name).catch(() => undefined);
      } catch (e) {
        const msg = String((e as Error)?.stack ?? e);
        this.status.set(name, "error");
        this.errors.set(name, msg.slice(0, 2000));
        logger.error(`plugin:${name}`, `load failed: ${msg}`);
        void this.persistMeta(name).catch(() => undefined);
        throw e;
      }
    });
  }

  /** Hot reload: valida la nueva versión; si falla conserva la activa. */
  async reload(name: string): Promise<void> {
    return this.withLock(name, async () => {
      const prev = this.loaded.get(name);
      this.status.set(name, "loading");
      try {
        const toml = await readConfigToml(name);
        const config = parseConfig(toml);
        const check = await syntaxCheck(name);
        if (!check.ok) throw new Error(`syntax: ${check.error}`);
        const def = (await importFresh(name)) as PluginDefinition;
        const err = validateDefinition(def);
        if (err) throw new Error(err);
        // Nueva versión válida → limpiar anterior.
        // Snapshot de horarios pendientes ANTES del teardown (que los borra):
        // si la cadencia no cambió, se conserva el tiempo restante.
        const jobSnap = this.scheduler.snapshot(name);
        if (prev) await runWithPlugin(name, () => this.teardown(name, prev));
        const registry = new PluginRegistry();
        const api = createApi({
          name,
          client: this.client,
          registry,
          scheduler: this.scheduler,
          config,
          botConfig: { prefix: this.prefix },
          isGuildAllowed: (g) => this.isGuildAllowed(g),
          varDefs: await readVarDefs(name),
          uiRegistry: this.ui,
          bus: {
            on: (plugin, fullEvent, handler) => this.onBus(plugin, fullEvent, handler),
            off: (plugin, fullEvent, handler) => this.offBus(plugin, fullEvent, handler),
            emit: (source, evName, ...args) => this.emitBus(source, evName, ...args),
          },
        });
        const t0 = Date.now();
        const setup = runWithPlugin(name, () => def.setup(api));
        if (setup instanceof Promise) {
          await Promise.race([
            setup,
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error("setup timeout (10s)")), 10_000),
            ),
          ]);
        }
        const startupMs = Date.now() - t0;
        pluginMetrics.startup(name, startupMs);
        this.loaded.set(name, {
          def,
          registry,
          config,
          version: def.version ?? "0.1.0",
          description: def.description,
          displayName: displayNameOf(name, def),
          startupMs,
        });
        this.status.set(name, "active");
        this.errors.delete(name);
        this.loadedAt.set(name, new Date().toISOString());
        // El setup re-registró las tareas: restaura horarios pendientes
        // con la misma cadencia (si cambió, arranque fresco).
        this.scheduler.restore(name, jobSnap);
        logger.info(`plugin:${name}`, "recargado OK");
        this.warnCommandConflicts(name);
        await this.registerSlashCommands(name).catch(() => undefined);
      } catch (e) {
        const msg = String((e as Error)?.stack ?? e);
        // Conserva versión anterior si existía, pero SIEMPRE guarda el error
        // para que el panel (/api/plugins) lo muestre en vez de "todo bien".
        if (prev && !this.loaded.has(name)) this.loaded.set(name, prev);
        this.status.set(name, prev ? "active" : "error");
        this.errors.set(name, msg.slice(0, 2000));
        if (prev) logger.warn(`plugin:${name}`, `reload falló, se conserva versión activa: ${msg.slice(0, 300)}`);
        logger.error(`plugin:${name}`, `reload failed: ${msg}`);
        throw e;
      } finally {
        void this.persistMeta(name).catch(() => undefined);
      }
    });
  }

  async unload(name: string) {
    return this.withLock(name, async () => {
      this.status.set(name, "unloading");
      const l = this.loaded.get(name);
      if (l) await runWithPlugin(name, () => this.teardown(name, l));
      this.loaded.delete(name);
      this.status.set(name, "disabled");
      this.enabled.set(name, false);
      this.errors.delete(name);
      logger.info(`plugin:${name}`, "descargado");
      void this.persistMeta(name).catch(() => undefined);
    });
  }

  async enable(name: string) {
    this.enabled.set(name, true);
    await this.load(name);
  }

  async disable(name: string) {
    await this.unload(name);
  }

  /**
   * Olvido total tras borrar del disco: limpia las claves en memoria para
   * que list() ya no devuelva el plugin (si no, quedaría como "descansando").
   * No persiste: la ruta DELETE ya borra la fila en DB. Síncrono a propósito
   * para no colisionar con el lock de unload().
   */
  forget(name: string) {
    this.loaded.delete(name);
    this.status.delete(name);
    this.errors.delete(name);
    this.loadedAt.delete(name);
    this.enabled.delete(name);
    this.locks.delete(name);
    this.corePlugins.delete(name);
  }

  /**
   * Recarga solo si el plugin está en memoria (activo o con error).
   * Si está apagado no hace nada: la config nueva se leerá al
   * encender/arrancar, que siempre leen el archivo fresco.
   */
  async reloadIfLoaded(name: string): Promise<void> {
    const s = this.status.get(name);
    if (s !== "active" && s !== "error") return;
    logger.info(`plugin:${name}`, "config.toml cambió: recarga automática ✨");
    await this.reload(name).catch(() => undefined);
  }

  /** Suscribe un plugin al bus (`twitch:stream-started`). */
  onBus(plugin: string, fullEvent: string, handler: (...a: never[]) => unknown): void {
    let set = this.bus.get(fullEvent);
    if (!set) {
      set = new Set();
      this.bus.set(fullEvent, set);
    }
    set.add({ plugin, handler });
  }

  /** Retira suscripciones del bus (todas si no se pasa handler). */
  offBus(plugin: string, fullEvent: string, handler?: (...a: never[]) => unknown): void {
    const set = this.bus.get(fullEvent);
    if (!set) return;
    for (const e of [...set]) {
      if (e.plugin === plugin && (!handler || e.handler === handler)) set.delete(e);
    }
    if (set.size === 0) this.bus.delete(fullEvent);
  }

  /**
   * Emite `<origen>:<evento>` a suscriptores de cualquier plugin.
   * Nunca lanza por listeners: errores aislados con log atribuido.
   */
  async emitBus(source: string, name: string, ...args: unknown[]): Promise<void> {
    const full = `${source}:${name}`;
    const set = this.bus.get(full);
    if (!set || set.size === 0) return;
    await Promise.all(
      [...set].map(async ({ plugin, handler }) => {
        try {
          await runWithPlugin(plugin, () => handler(...(args as never[])) as unknown);
        } catch (e) {
          logger.error(`plugin:${plugin}`, `bus ${full}: ${String(e)}`);
        }
      }),
    );
  }

  private removeBusListeners(plugin: string): void {
    for (const [ev, set] of this.bus) {
      for (const e of [...set]) {
        if (e.plugin === plugin) set.delete(e);
      }
      if (set.size === 0) this.bus.delete(ev);
    }
  }

  private async teardown(name: string, l: Loaded) {
    // Baja las tareas programadas del plugin (cancela timers pendientes).
    this.scheduler.removePlugin(name);
    // Baja la UI declarativa (sin tabs/widgets huérfanos tras reload).
    this.ui.removePlugin(name);
    // Baja las suscripciones al bus (sin oyentes huérfanos tras reload).
    this.removeBusListeners(name);
    for (const { event, handler } of l.registry.listeners) {
      try {
        (this.client.off as (...args: unknown[]) => void)(event, handler as (...a: never[]) => void);
      } catch {
        /* noop */
      }
    }
    try {
      await l.def.teardown?.();
    } catch (e) {
      logger.warn(`plugin:${name}`, `teardown: ${String(e)}`);
    }
    await l.registry.dispose(name);
  }

  /** Ganador por comando: primer plugin cargado que lo registró (dispatcher). */
  private commandWinners(): Map<string, string> {
    const winners = new Map<string, string>();
    for (const [plugin, l] of this.loaded) {
      for (const cmd of l.registry.commands.keys()) {
        if (!winners.has(cmd)) winners.set(cmd, plugin);
      }
    }
    return winners;
  }

  /** Avisa en logs si algún comando del plugin pierde por duplicado. */
  private warnCommandConflicts(name: string) {
    const l = this.loaded.get(name);
    if (!l) return;
    const winners = this.commandWinners();
    for (const cmd of l.registry.commands.keys()) {
      const winner = winners.get(cmd);
      if (winner && winner !== name) {
        logger.warn(
          `plugin:${name}`,
          `comando !${cmd} duplicado: responde "${winner}" (primer registro gana)`,
        );
      }
    }
  }

  /** Comandos registrados por un plugin cargado (orden alfabético). */
  commandsOf(name: string): { name: string; description?: string; conflict?: boolean; owner?: string; slash?: boolean }[] {
    const l = this.loaded.get(name);
    if (!l) return [];
    const winners = this.commandWinners();
    return [...l.registry.commands.entries()]
      .map(([cmd, entry]) => {
        const winner = winners.get(cmd);
        const out: { name: string; description?: string; conflict?: boolean; owner?: string; slash?: boolean } = { name: cmd };
        if (entry.description) out.description = entry.description;
        if (winner && winner !== name) {
          out.conflict = true;
          out.owner = winner;
        }
        if (entry.slash) out.slash = true;
        return out;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Endpoints públicos del plugin (`/plugin-routes/<plugin>/<path>`). */
  routesOf(name: string): { method: "GET" | "POST"; path: string; raw: boolean }[] {
    const l = this.loaded.get(name);
    if (!l) return [];
    return [...l.registry.routes.values()]
      .map((r) => ({ method: r.method, path: r.path, raw: r.raw }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Resuelve un handler HTTP de un plugin activo.
   * Devuelve null si el plugin no está activo o la ruta no existe.
   */
  resolveHttpRoute(plugin: string, method: string, subpath: string) {
    if (this.status.get(plugin) !== "active") return null;
    const l = this.loaded.get(plugin);
    if (!l) return null;
    const p = subpath.replace(/^\/+|\/+$/g, "");
    const entry = l.registry.routes.get(`${method.toUpperCase()} ${p}`);
    if (!entry) return null;
    return { entry, plugin };
  }

  list(): PluginRecord[] {
    const names = new Set([...this.status.keys(), ...this.loaded.keys(), ...this.enabled.keys()]);
    return [...names].map((name) => {
      const l = this.loaded.get(name);
      pluginMetrics.sampleProcess(name);
      return {
        name,
        displayName: l?.displayName ?? name,
        version: l?.version ?? "0.1.0",
        description: l?.description,
        status: this.status.get(name) ?? "disabled",
        enabled: this.enabled.get(name) ?? false,
        core: this.corePlugins.has(name),
        lastError: this.errors.get(name),
        lastLoadedAt: this.loadedAt.get(name),
        startupMs: l?.startupMs ?? null,
        commands: this.commandsOf(name),
        routes: this.routesOf(name),
        metrics: pluginMetrics.getSnapshot(name),
      };
    });
  }

  getStatus(name: string) {
    pluginMetrics.sampleProcess(name);
    const l = this.loaded.get(name);
    return {
      name,
      displayName: l?.displayName ?? name,
      status: this.status.get(name) ?? "disabled",
      enabled: this.enabled.get(name) ?? false,
      core: this.corePlugins.has(name),
      lastError: this.errors.get(name),
      lastLoadedAt: this.loadedAt.get(name),
      startupMs: l?.startupMs ?? null,
      commands: this.commandsOf(name),
      routes: this.routesOf(name),
      metrics: pluginMetrics.getSnapshot(name),
    };
  }

  /** Métricas detalladas de un plugin (comandos, HTTP, jobs, proceso). */
  getMetrics(name: string): PluginMetricsDTO | null {
    return pluginMetrics.getSnapshot(name);
  }

  private async persistMeta(name: string) {
    try {
      const { getDb } = await import("../db/client.js");
      const { plugins } = await import("../db/schema.js");
      const { eq } = await import("drizzle-orm");
      const db = getDb();
      const l = this.loaded.get(name);
      const row = {
        name,
        version: l?.version ?? "0.1.0",
        enabled: this.enabled.get(name) ?? false,
        status: this.status.get(name) ?? "disabled",
        lastError: this.errors.get(name) ?? null,
        lastLoadedAt: this.loadedAt.get(name) ? new Date(this.loadedAt.get(name)!) : null,
      };
      const existing = await db.select().from(plugins).where(eq(plugins.name, name)).limit(1);
      if (existing.length === 0) await db.insert(plugins).values(row as never);
      else await db.update(plugins).set(row as never).where(eq(plugins.name, name));
    } catch {
      /* DB opcional */
    }
  }
}
