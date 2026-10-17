import type { Client } from "discord.js";

export type PluginStatus =
  | "disabled"
  | "loading"
  | "active"
  | "error"
  | "unloading";

export interface PluginEvents {
  /**
   * Sin `:`: evento de discord.js (`messageCreate`, …).
   * Con `:`: bus inter-plugin (`twitch:stream-started`).
   */
  on(event: string, handler: (...args: never[]) => unknown): void;
  off(event: string, handler: (...args: never[]) => unknown): void;
}

export interface PluginCommands {
  register(
    name: string,
    handler: (ctx: CommandCtx, ...args: string[]) => unknown,
    opts?: { description?: string; slash?: SlashCommandDef },
  ): void;
  unregister(name: string): void;
}

export interface JobOpts {
  description?: string;
  /** Timeout por ejecución en ms (defecto 30000, entre 5000 y 300000). */
  timeoutMs?: number;
}

export interface PluginJobs {
  /** Recurrente cada intervalo ("30s", "5m", "2h", "1d" o ms, mínimo 10s). Devuelve el ID. */
  every(name: string, interval: string | number, handler: () => unknown, opts?: JobOpts): string;
  /** Recurrente con cron de 5 campos ("0 9 * * *"). Devuelve el ID. */
  cron(name: string, expr: string, handler: () => unknown, opts?: JobOpts): string;
  /** Una sola vez dentro de delayMs (5s–30d). Sobrevive reinicios (mismo ID). */
  in(name: string, delayMs: number, handler: () => unknown, opts?: JobOpts): string;
  /** Una sola vez en una fecha futura. Sobrevive reinicios (mismo ID). */
  at(name: string, date: Date | string | number, handler: () => unknown, opts?: JobOpts): string;
  /** Cancela un one-shot pendiente. Solo one-shots. */
  cancel(id: string): boolean;
}

export interface CommandCtx {
  message: import("discord.js").Message;
  content: string;
  args: string[];
}

export interface SlashCommandOption {
  name: string;
  description?: string;
  type?: "string" | "number" | "boolean" | "user" | "channel" | "role";
  required?: boolean;
  choices?: { name: string; value: string | number }[];
  min_value?: number;
  max_value?: number;
}

export interface SlashCommandDef {
  description: string;
  options?: SlashCommandOption[];
}

export interface DiscordComponentDef {
  id: string;
  type: "button" | "selectMenu" | "modal";
  label?: string;
  style?: "primary" | "secondary" | "success" | "danger";
  placeholder?: string;
  options?: { label: string; value: string; description?: string; emoji?: string }[];
  components?: DiscordComponentDef[];
}

export interface InteractionCtx {
  interaction: import("discord.js").Interaction;
  customId: string;
  values: string[];
  user: import("discord.js").User;
  channel: import("discord.js").TextBasedChannel | null;
  guild: import("discord.js").Guild | null;
  reply(content: string | import("discord.js").InteractionReplyOptions): Promise<unknown>;
  deferReply(): Promise<unknown>;
  editReply(content: string | import("discord.js").InteractionEditReplyOptions): Promise<unknown>;
  showModal(modal: { customId: string; title: string; components: unknown[] }): Promise<unknown>;
}

export type HttpMethod = "GET" | "POST";

export interface HttpRouteOpts {
  /**
   * `true` = handler recibe bytes crudos (`rawBody`) sin parsear.
   * Imprescindible para verificar firmas HMAC (Twitch EventSub, etc.),
   * que se calculan sobre los bytes exactos del body.
   */
  raw?: boolean;
}

export interface HttpCtx {
  method: HttpMethod;
  /** Subruta dentro del plugin (`eventsub` en `/plugin-routes/twitch/eventsub`). */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Bytes exactos del body (siempre disponible; con `raw: true` es lo principal). */
  rawBody: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
}

export type HttpHandlerResult =
  | void
  | string
  | Record<string, unknown>
  | Response
  | { status?: number; body?: unknown; headers?: Record<string, string> };

export interface PluginHttp {
  /**
   * Expone `GET /plugin-routes/<plugin>/<path>` (público, sin sesión).
   * Máx 8 rutas por plugin; `path` relativo `a-z, 0-9, -, _, /` (máx 64).
   */
  get(path: string, handler: (ctx: HttpCtx) => unknown, opts?: HttpRouteOpts): void;
  /** Expone `POST /plugin-routes/<plugin>/<path>` (público, sin sesión). */
  post(path: string, handler: (ctx: HttpCtx) => unknown, opts?: HttpRouteOpts): void;
  unregister(path: string): void;
}

export interface PluginLib {
  /**
   * Importa un módulo ESM remoto (esm.sh, jsdelivr) con caché en disco.
   * La URL debe estar pineada a versión exacta (`paquete@1.2.3`) y ser https
   * de un host permitido. En esm.sh usa `?bundle&target=node`.
   * Lanza si la URL no es válida o la descarga falla.
   */
  importUrl(url: string): Promise<unknown>;
  /**
   * Importa un paquete npm instalado en el host (`package.json` raíz).
   * Es la vía preferida para core plugins: offline, versionada con el repo
   * y sin depender del CDN. Lanza si el paquete no está instalado
   * (`pnpm add <paquete>`); combina con `importUrl` como plan B.
   */
  pkg(name: string): Promise<unknown>;
}

export type VarValue = number | string | boolean;

export interface PluginVars {
  /** Lee una variable (guardado ?? default del schema ?? fallback). */
  get(key: string, fallback?: VarValue): Promise<VarValue | undefined>;
  /** Escribe una variable (valida tipo contra schema.yml). */
  set(key: string, value: VarValue): Promise<void>;
  /** Suma (o resta con by negativo) y devuelve el nuevo valor. Solo number. */
  incr(key: string, by?: number): Promise<number>;
  decr(key: string, by?: number): Promise<number>;
  /** Borra el valor guardado (vuelve al default). Devuelve el default. */
  reset(key: string): Promise<VarValue | undefined>;
  /** ¿Tiene valor guardado? */
  has(key: string): Promise<boolean>;
  /** Todas las declaradas con su valor efectivo. */
  all(): Promise<Record<string, VarValue>>;
}

export type UiWidgetKind = "stat" | "table" | "list" | "line" | "bars" | "text" | "actions";

/** Iconos permitidos (se mapean a lucide en el panel; resto → genérico). */
export type UiIcon = "chart" | "table" | "video" | "bell" | "clock" | "list" | "info" | "zap" | "puzzle";

export interface UiTabDef {
  /** ID estable dentro del plugin (a-z, 0-9, -, _; máx 48). Ruta: /p/:plugin/:tab */
  id: string;
  label: string;
  icon?: UiIcon;
  description?: string;
}

interface UiWidgetBase {
  /** ID estable dentro del tab (a-z, 0-9, -, _; máx 48). */
  id: string;
  title?: string;
  /** Refresco en ms (mínimo 5000). Por defecto el tab no refresca solo. */
  refreshMs?: number;
  /** Ancho en la rejilla. Por defecto "half". */
  width?: "full" | "half";
}

export interface UiStatWidget extends UiWidgetBase {
  kind: "stat";
  /** ID del provider (api.ui.data) o valor literal. */
  data: string;
  suffix?: string;
  icon?: UiIcon;
}

export interface UiTableWidget extends UiWidgetBase {
  kind: "table";
  /** ID del provider que devuelve unknown[][] (filas). */
  data: string;
  columns: { key: string; label: string; mono?: boolean }[];
  empty?: string;
}

export interface UiListWidget extends UiWidgetBase {
  kind: "list";
  /** ID del provider que devuelve string[]. */
  data: string;
  empty?: string;
}

export interface UiSeriesWidget extends UiWidgetBase {
  kind: "line" | "bars";
  /** ID del provider que devuelve number[]. */
  data: string;
  empty?: string;
}

export interface UiTextWidget extends UiWidgetBase {
  kind: "text";
  /** ID del provider que devuelve string. */
  data: string;
}

export interface UiActionsWidget extends UiWidgetBase {
  kind: "actions";
  /** IDs de acciones registradas con api.ui.action. */
  items: string[];
}

export type UiWidget =
  | UiStatWidget
  | UiTableWidget
  | UiListWidget
  | UiSeriesWidget
  | UiTextWidget
  | UiActionsWidget;

export interface UiActionDef {
  /** ID estable (a-z, 0-9, -, _; máx 48). */
  id: string;
  label: string;
  variant?: "default" | "secondary" | "destructive";
  /** Si se define, el panel pide confirmación con este texto. */
  confirm?: string;
}

export interface PluginUi {
  /** Registra una pestaña del plugin (visible en el sidebar). */
  registerTab(tab: UiTabDef): void;
  unregisterTab(id: string): void;
  /** Coloca un widget en una pestaña registrada. */
  widget(tabId: string, widget: UiWidget): void;
  /** Fuente de datos: se invoca por petición con timeout y errores aislados. */
  data(id: string, provider: () => unknown): void;
  /** Acción invocable desde un widget `actions`. Devuelve mensaje para el toast. */
  action(def: UiActionDef, handler: (args: Record<string, unknown>) => unknown): void;
  unregisterAction(id: string): void;
}

export interface PluginDiscordUi {
  button(def: DiscordComponentDef, handler: (ctx: InteractionCtx) => unknown): { type: 1; style: number; label?: string; custom_id: string };
  selectMenu(def: DiscordComponentDef, handler: (ctx: InteractionCtx) => unknown): { type: 3; custom_id: string; placeholder?: string; options: unknown[] };
  modal(def: DiscordComponentDef, handler: (ctx: InteractionCtx) => unknown): { type: 9; custom_id: string; title?: string; components: unknown[] };
  unregister(id: string): void;
}

export interface PluginRouteInfo {
  method: HttpMethod;
  /** Subruta (`eventsub` en `/plugin-routes/twitch/eventsub`). */
  path: string;
  /** `true` = recibe bytes crudos (firmas HMAC). */
  raw: boolean;
}

export interface PluginApi {
  name: string;
  config: Record<string, unknown>;
  botConfig: { prefix: string };
  client: Client;
  events: PluginEvents;
  /**
   * Emite al bus inter-plugin con namespace automático:
   * `api.emit("stream-started", datos)` → `twitch:stream-started`.
   * Los oyentes no te tumban: errores aislados con log. Sin oyentes = noop.
   */
  emit(event: string, ...args: unknown[]): Promise<void>;
  commands: PluginCommands;
  jobs: PluginJobs;
  vars: PluginVars;
  ui: PluginUi;
  /** Endpoints públicos del plugin (`/plugin-routes/<plugin>/<path>`). */
  http: PluginHttp;
  /** Importa ESM remoto (esm.sh) con caché en disco. */
  lib: PluginLib;
  /** Interacciones de Discord: slash commands, botones, selects, modales. */
  discord: PluginDiscordUi;
  sendMessage(channel: unknown, content: string): Promise<unknown>;
  reply(message: unknown, content: string): Promise<unknown>;
  sendEmbed(
    channel: unknown,
    embed: Record<string, unknown>,
  ): Promise<unknown>;
  log: { info(m: string): void; warn(m: string): void; error(m: string): void };
  onCleanup(fn: () => unknown): void;
}

export interface PluginDefinition {
  /**
   * Nombre visible en el panel. Opcional: si falta o es vacío se usa
   * el ID de la carpeta. No tiene que coincidir con la carpeta.
   */
  name?: string;
  version?: string;
  description?: string;
  setup(api: PluginApi): void | Promise<void>;
  teardown?(): void | Promise<void>;
}

export interface PluginCommandInfo {
  /** Nombre sin prefijo, en minúsculas (`!hola` → `hola`). */
  name: string;
  /** Descripción corta (de `register(..., { description })`). */
  description?: string;
  /** True si otro plugin cargado antes ya registró el mismo comando (este pierde). */
  conflict?: boolean;
  /** Plugin que responde al comando cuando hay duplicado (primer registro). */
  owner?: string;
  /** También registrado como slash command `/nombre`. */
  slash?: boolean;
}

export interface PluginRecord {
  /** ID estable: nombre de la carpeta en `data/plugins/`. */
  name: string;
  /** Nombre visible en el panel (`definePlugin({ name })`, o el ID). */
  displayName: string;
  version: string;
  description?: string;
  status: PluginStatus;
  enabled: boolean;
  /** Core: viene con la app, no editable desde el panel (solo ajustes + on/off). */
  core: boolean;
  lastError?: string;
  lastLoadedAt?: string;
  /** Comandos `!nombre` registrados por el plugin activo. Vacío si apagado. */
  commands: PluginCommandInfo[];
  /** Endpoints públicos (`/plugin-routes/<plugin>/<path>`). Vacío si apagado. */
  routes: PluginRouteInfo[];
}
