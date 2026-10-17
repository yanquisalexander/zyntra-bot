import { logger } from "./logger.js";

export interface RegisteredCommand {
  handler: (ctx: never, ...a: string[]) => unknown;
  /** Descripción corta (de `register(..., { description })`). Para el panel. */
  description?: string;
  /** Definición slash (de `register(..., { slash: {...} })`). */
  slash?: { description: string; options?: unknown[] };
  /** ID Discord del comando slash (tras registrarlo en el guild). */
  discordId?: string;
}

export interface RegisteredRoute {
  method: "GET" | "POST";
  /** Subruta normalizada sin slashes externos (`eventsub/callback`). */
  path: string;
  /** `true` = el handler recibe bytes crudos (firmas HMAC). */
  raw: boolean;
  handler: (ctx: never) => unknown;
}

export interface RegisteredComponent {
  /** `button:<id>` / `select:<id>` / `modal:<id>` */
  customId: string;
  handler: (ctx: never) => unknown;
}

/** Registra recursos por plugin para limpieza segura (sin listeners huérfanos). */
export class PluginRegistry {
  listeners: { event: string; handler: (...a: never[]) => void }[] = [];
  commands = new Map<string, RegisteredCommand>();
  routes = new Map<string, RegisteredRoute>();
  components = new Map<string, RegisteredComponent>();
  timers = new Set<NodeJS.Timeout>();
  cleanups: (() => unknown)[] = [];

  async dispose(plugin: string) {
    for (const fn of this.cleanups) {
      try {
        await fn();
      } catch (e) {
        logger.warn(`plugin:${plugin}`, `cleanup failed: ${String(e)}`);
      }
    }
    for (const t of this.timers) clearTimeout(t);
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    this.cleanups = [];
    // listeners los retira el manager (tiene acceso al client)
    this.listeners = [];
    this.commands.clear();
    this.routes.clear();
    this.components.clear();
  }
}
