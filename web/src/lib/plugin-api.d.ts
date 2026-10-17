/**
 * Zyntra Bot — tipos del editor (panel web).
 *
 * Esta declaración se inyecta en Monaco como lib extra (`addExtraLib`) para
 * dar autocompletado y hover en `plugin.js`. Es solo para el editor: el
 * runtime de plugins la ignora.
 *
 * Mantener sincronizado con `src/plugins/types.ts` y `docs/plugin-api.md`.
 * Nota: los objetos de discord.js se modelan de forma mínima y permisiva
 * (con índice `any`) para ayudar sin marcar errores en código válido.
 */

/** Registra la definición del plugin. Es la única global que necesitas. */
declare function definePlugin(def: PluginDefinition): PluginDefinition;

interface PluginDefinition {
  /**
   * Nombre visible en el panel. Opcional y libre (no tiene que coincidir
   * con la carpeta, que es el ID estable). Si falta, se muestra el ID.
   */
  name?: string;
  version?: string;
  description?: string;
  /** Se ejecuta al cargar/recargar. Timeout de 10s. Un throw no tumba el bot. */
  setup(api: PluginApi): void | Promise<void>;
  /** Limpieza extra opcional (el manager ya retira listeners/comandos). */
  teardown?(): void | Promise<void>;
}

interface BotConfig {
  /** Prefijo de comandos (`!` por defecto). */
  prefix: string;
}

interface PluginEvents {
  /** Evento de bienvenida: `member.user.username`, `member.guild.systemChannel`… */
  on(event: "guildMemberAdd" | "guildMemberRemove", handler: (member: DiscordMember) => unknown): void;
  /** Mensajes: `message.content`, `message.author.username`… */
  on(event: "messageCreate", handler: (message: DiscordMessage) => unknown): void;
  /** Bus inter-plugin: `twitch:stream-started`, … */
  on(event: `${string}:${string}`, handler: (...args: any[]) => unknown): void;
  /** Cualquier otro evento del Client de discord.js. */
  on(event: string, handler: (...args: any[]) => unknown): void;
  off(event: string, handler: (...args: any[]) => unknown): void;
}

interface PluginCommands {
  /**
   * Registra `!nombre`. El dispatcher pasa `ctx` + args separados.
   * Con `slash: { description, options }` también se registra como `/nombre`.
   * @example api.commands.register("hola", async (ctx) => { await api.reply(ctx.message, "¡Hola!"); }, { description: "Saluda", slash: { description: "Saluda al usuario" } });
   */
  register(
    name: string,
    handler: (ctx: CommandCtx, ...args: string[]) => unknown,
    opts?: { description?: string; slash?: { description?: string; options?: { name: string; type?: "string" | "number" | "boolean" | "user" | "channel" | "role"; required?: boolean; choices?: { name: string; value: string | number }[] }[] } },
  ): void;
  unregister(name: string): void;
}

interface CommandCtx {
  message: DiscordMessage;
  /** Contenido crudo del mensaje. */
  content: string;
  /** Argumentos tras el comando, separados por espacios. */
  args: string[];
}

interface DiscordComponentDef {
  id: string;
  type: "button" | "selectMenu" | "modal";
  label?: string;
  style?: "primary" | "secondary" | "success" | "danger";
  placeholder?: string;
  options?: { label: string; value: string; description?: string; emoji?: string }[];
  components?: DiscordComponentDef[];
}

interface InteractionCtx {
  interaction: any;
  customId: string;
  values: string[];
  user: { id: string; username: string; tag: string };
  channel: any | null;
  guild: any | null;
  reply(content: string | { content?: string; ephemeral?: boolean }): Promise<any>;
  deferReply(): Promise<any>;
  editReply(content: string | { content?: string }): Promise<any>;
  showModal(modal: { customId: string; title: string; components: unknown[] }): Promise<any>;
}

interface PluginDiscordUi {
  /** Botón: {type:1, style, label, custom_id}. Se pone en msg.components[0]. */
  button(def: DiscordComponentDef, handler: (ctx: InteractionCtx) => unknown): { type: 1; style: number; label?: string; custom_id: string };
  /** Select menu: {type:3, custom_id, placeholder, options}. */
  selectMenu(def: DiscordComponentDef, handler: (ctx: InteractionCtx) => unknown): { type: 3; custom_id: string; placeholder?: string; options: unknown[] };
  /** Modal: {type:9, custom_id, title, components}. */
  modal(def: DiscordComponentDef, handler: (ctx: InteractionCtx) => unknown): { type: 9; custom_id: string; title?: string; components: unknown[] };
  unregister(id: string): void;
}

interface HttpCtx {
  method: "GET" | "POST";
  /** Subruta dentro del plugin (`eventsub` en `/plugin-routes/twitch/eventsub`). */
  path: string;
  query: Record<string, string>;
  /** Cabeceras en minúsculas. */
  headers: Record<string, string>;
  /** Bytes exactos del body (siempre disponible). */
  rawBody: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
}

interface PluginHttp {
  /**
   * Expone `GET /plugin-routes/<plugin>/<path>` (público, sin sesión).
   * `path` relativo `a-z, 0-9, -, _, /` (máx 64). Máx 8 rutas por plugin.
   * @example api.http.post("eventsub", async (ctx) => "ok", { raw: true });
   */
  get(path: string, handler: (ctx: HttpCtx) => unknown, opts?: { raw?: boolean }): void;
  /** Expone `POST /plugin-routes/<plugin>/<path>` (público, sin sesión). */
  post(path: string, handler: (ctx: HttpCtx) => unknown, opts?: { raw?: boolean }): void;
  unregister(path: string): void;
}

interface PluginLib {
  /**
   * Importa un módulo ESM remoto con caché en disco.
   * Solo https de esm.sh/jsdelivr, versión exacta (`paquete@1.2.3`).
   * En esm.sh usa `?bundle&target=node` (un solo fichero autocontenido).
   * @example const { AppTokenAuthProvider } = await api.lib.importUrl("https://esm.sh/@twurple/auth@8.0.3?bundle&target=node");
   */
  importUrl(url: string): Promise<any>;
  /**
   * Importa un paquete npm instalado en el host. Vía preferida para
   * dependencias estables (offline, versionada con el repo).
   * @example const { ApiClient } = await api.lib.pkg("@twurple/api");
   */
  pkg(name: string): Promise<any>;
}

interface JobOpts {
  description?: string;
  /** Timeout por ejecución en ms (defecto 30000, entre 5000 y 300000). */
  timeoutMs?: number;
}

interface PluginJobs {
  /**
   * Tarea recurrente cada intervalo ("30s", "5m", "2h", "1d" o ms, mínimo 10s).
   * @example api.jobs.every("resumen", "5m", async () => { api.log.info("toc"); });
   */
  every(name: string, interval: string | number, handler: () => unknown, opts?: JobOpts): string;
  /**
   * Tarea recurrente con cron de 5 campos ("0 9 * * *").
   * Un cron mal formado no tumba el plugin: queda marcado inválido.
   */
  cron(name: string, expr: string, handler: () => unknown, opts?: JobOpts): string;
  /** Una sola vez dentro de delayMs (5s–30d). Sobrevive reinicios (mismo ID). */
  in(name: string, delayMs: number, handler: () => unknown, opts?: JobOpts): string;
  /** Una sola vez en fecha futura. Sobrevive reinicios (mismo ID). */
  at(name: string, date: Date | string | number, handler: () => unknown, opts?: JobOpts): string;
  /** Cancela un one-shot pendiente. Solo one-shots. */
  cancel(id: string): boolean;
}

type VarValue = number | string | boolean;

interface PluginVars {
  /**
   * Lee una variable (guardado ?? default del schema ?? fallback).
   * Solo claves declaradas con `type: variable` en schema.yml.
   * @example const n = await api.vars.get("contador", 0);
   */
  get(key: string, fallback?: VarValue): Promise<VarValue | undefined>;
  /** Escribe una variable (valida tipo contra schema.yml). Persiste en vars.json. */
  set(key: string, value: VarValue): Promise<void>;
  /**
   * Suma (o resta con by negativo) y devuelve el nuevo valor. Solo number.
   * @example const n = await api.vars.incr("contador", 1);
   */
  incr(key: string, by?: number): Promise<number>;
  decr(key: string, by?: number): Promise<number>;
  /** Borra el valor guardado (vuelve al default). Devuelve el default. */
  reset(key: string): Promise<VarValue | undefined>;
  /** ¿Tiene valor guardado? */
  has(key: string): Promise<boolean>;
  /** Todas las declaradas con su valor efectivo. */
  all(): Promise<Record<string, VarValue>>;
}

type UiIcon = "chart" | "table" | "video" | "bell" | "clock" | "list" | "info" | "zap" | "puzzle";

interface UiTabDef {
  /** ID estable dentro del plugin. Ruta: /p/:plugin/:tab */
  id: string;
  label: string;
  icon?: UiIcon;
  description?: string;
}

interface UiWidgetBase {
  id: string;
  title?: string;
  /** Refresco en ms (mínimo 5000). */
  refreshMs?: number;
  width?: "full" | "half";
}

interface UiStatWidget extends UiWidgetBase {
  kind: "stat";
  /** ID del provider (api.ui.data) o valor literal. */
  data: string;
  suffix?: string;
  icon?: UiIcon;
}

interface UiTableWidget extends UiWidgetBase {
  kind: "table";
  /** ID del provider que devuelve unknown[][] (filas). */
  data: string;
  columns: { key: string; label: string; mono?: boolean }[];
  empty?: string;
}

interface UiListWidget extends UiWidgetBase {
  kind: "list";
  /** ID del provider que devuelve string[]. */
  data: string;
  empty?: string;
}

interface UiSeriesWidget extends UiWidgetBase {
  kind: "line" | "bars";
  /** ID del provider que devuelve number[]. */
  data: string;
  empty?: string;
}

interface UiTextWidget extends UiWidgetBase {
  kind: "text";
  /** ID del provider que devuelve string. */
  data: string;
}

interface UiActionsWidget extends UiWidgetBase {
  kind: "actions";
  /** IDs de acciones registradas con api.ui.action. */
  items: string[];
}

type UiWidget =
  | UiStatWidget
  | UiTableWidget
  | UiListWidget
  | UiSeriesWidget
  | UiTextWidget
  | UiActionsWidget;

interface UiActionDef {
  id: string;
  label: string;
  variant?: "default" | "secondary" | "destructive";
  /** Si se define, el panel pide confirmación con este texto. */
  confirm?: string;
}

interface PluginUi {
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

interface PluginApi {
  /** Nombre del plugin. */
  name: string;
  /** Objeto parseado de `config.toml` (solo lectura; edítalo en la pestaña Config). */
  config: Record<string, unknown>;
  botConfig: BotConfig;
  /** Client de discord.js (acceso directo, sin re-imports). */
  client: any;
  /** Suscribe eventos del client con wrap anti-crash por handler. */
  events: PluginEvents;
  /**
   * Emite al bus inter-plugin con namespace automático:
   * `api.emit("stream-started", datos)` → `twitch:stream-started`.
   * @example api.events.on("twitch:stream-started", async (ev) => { … });
   */
  emit(event: string, ...args: any[]): Promise<void>;
  /** Comandos `!nombre` (dispatcher `messageCreate`). */
  commands: PluginCommands;
  /** Tareas programadas: intervalos, cron y one-shots con panel propio. */
  jobs: PluginJobs;
  /** Variables persistentes entre comandos (decláralas en schema.yml). */
  vars: PluginVars;
  /** UI declarativa: pestañas, widgets y acciones en el panel. */
  ui: PluginUi;
  /** Endpoints públicos del plugin (`/plugin-routes/<plugin>/<path>`). */
  http: PluginHttp;
  /** Importa ESM remoto (esm.sh) con caché en disco. */
  lib: PluginLib;
  /** Componentes de Discord: botones, selects, modales. */
  discord: PluginDiscordUi;
  /** Envía a un canal enviable. Falla si el canal es null/no-enviable. */
  sendMessage(channel: unknown, content: string): Promise<unknown>;
  /** Responde a un mensaje. */
  reply(message: unknown, content: string): Promise<unknown>;
  /** Envía `{ embeds: [embed] }` a un canal enviable. */
  sendEmbed(channel: unknown, embed: Record<string, unknown>): Promise<unknown>;
  /** Log atribuido a tu plugin (visible en /logs). */
  log: { info(m: string): void; warn(m: string): void; error(m: string): void };
  /** Registra limpieza extra al descargar/recargar. */
  onCleanup(fn: () => unknown): void;
}

/** Usuario de Discord (vista mínima). */
interface DiscordUser {
  id: string;
  username: string;
  tag: string;
  bot: boolean;
  [key: string]: any;
}

/** Miembro de un servidor (vista mínima). */
interface DiscordMember {
  user: DiscordUser;
  guild: DiscordGuild;
  displayName: string;
  [key: string]: any;
}

/** Servidor de Discord (vista mínima). */
interface DiscordGuild {
  id: string;
  name: string;
  /** Puede ser null si el servidor no tiene canal de sistema. */
  systemChannel: DiscordChannel | null;
  channels: {
    fetch(id: string): Promise<DiscordChannel | null>;
    [key: string]: any;
  };
  [key: string]: any;
}

/** Canal de texto (vista mínima). */
interface DiscordChannel {
  id: string;
  name: string;
  send(content: string | unknown): Promise<unknown>;
  [key: string]: any;
}

/** Mensaje de Discord (vista mínima). */
interface DiscordMessage {
  author: DiscordUser;
  content: string;
  createdTimestamp: number;
  guild: DiscordGuild | null;
  channel: DiscordChannel;
  member: DiscordMember | null;
  reply(content: string): Promise<unknown>;
  [key: string]: any;
}
