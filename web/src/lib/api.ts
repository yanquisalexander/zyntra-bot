export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (res.status === 401) {
    // Sesión caducada o sin sesión: a la login page (no directo a Discord).
    window.location.href = "/login";
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface BootstrapBot {
  connected: boolean;
  tag: string | null;
  guilds: number;
  ping: number;
  /** discord.js Client.uptime — milisegundos desde READY */
  uptime: number;
  /** false = falta DISCORD_TOKEN en el servidor (pantalla de misconfig). */
  hasToken?: boolean;
}

export interface BootstrapPluginRoute {
  method: "GET" | "POST";
  path: string;
  raw?: boolean;
}

export interface BootstrapPlugin {
  name: string;
  displayName: string;
  version: string;
  status: string;
  enabled: boolean;
  lastError?: string;
  routes?: BootstrapPluginRoute[];
}

export interface PanelUser {
  username: string;
  discordId: string;
  avatar?: string | null;
}

/** URL del avatar de Discord (hash `a_…` = animado → gif, si no png). */
export function discordAvatarUrl(discordId: string, avatar: string | null | undefined, size = 64): string | null {
  if (!discordId || !avatar) return null;
  const ext = avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.${ext}?size=${size}`;
}

export interface BootstrapData {
  user?: PanelUser | null;
  bot?: BootstrapBot | null;
  plugins?: BootstrapPlugin[];
  uiTabs?: import("./ui.js").UiTabListItem[];
  flags?: { bypassAdminServerCheck?: boolean };
}

/**
 * Datos que el servidor inyecta en el HTML (`window.__BOOTSTRAP__`).
 * Se usan como estado inicial (usuario, bot, plugins y tabs) para pintar
 * al instante sin esperar a la API; luego cada página refresca.
 */
export function bootstrap(): BootstrapData {
  return (window as unknown as { __BOOTSTRAP__?: BootstrapData }).__BOOTSTRAP__ ?? {};
}

// ─── VCS: tipos y helpers de revisiones ──────────────────────────────────────

export interface PluginRevision {
  id: string;
  pluginId: string;
  codePreview: string;
  label: string | null;
  createdBy: string | null;
  createdAt: string;
  /** true si la carpeta del plugin ya no existe en el FS */
  orphan: boolean;
}

export interface PluginRevisionFull extends PluginRevision {
  code: string;
  configToml: string;
  schemaYml: string;
}

export interface OrphanGroup {
  pluginId: string;
  count: number;
  latestAt: string;
}

/** Lista las revisiones de un plugin (más reciente primero). */
export async function listRevisions(pluginId: string): Promise<PluginRevision[]> {
  const d = await api<{ revisions: PluginRevision[] }>(`/api/plugins/${encodeURIComponent(pluginId)}/revisions`);
  return d.revisions;
}

/** Crea un snapshot manual con etiqueta opcional. */
export async function createRevision(pluginId: string, label?: string): Promise<string> {
  const d = await api<{ id: string }>(`/api/plugins/${encodeURIComponent(pluginId)}/revisions`, {
    method: "POST",
    body: JSON.stringify({ label: label ?? null }),
  });
  return d.id;
}

/** Obtiene el detalle completo (código + config) de una revisión. */
export async function getRevision(pluginId: string, revId: string): Promise<PluginRevisionFull> {
  const d = await api<{ revision: PluginRevisionFull }>(
    `/api/plugins/${encodeURIComponent(pluginId)}/revisions/${encodeURIComponent(revId)}`,
  );
  return d.revision;
}

/** Restaura el plugin al estado de una revisión. */
export async function restoreRevision(pluginId: string, revId: string): Promise<void> {
  await api(`/api/plugins/${encodeURIComponent(pluginId)}/revisions/${encodeURIComponent(revId)}/restore`, {
    method: "POST",
  });
}

/** Elimina una revisión individual. */
export async function deleteRevision(pluginId: string, revId: string): Promise<void> {
  await api(`/api/plugins/${encodeURIComponent(pluginId)}/revisions/${encodeURIComponent(revId)}`, {
    method: "DELETE",
  });
}

/** Lista todos los plugins huérfanos (con revisiones pero sin carpeta). */
export async function listOrphans(): Promise<OrphanGroup[]> {
  const d = await api<{ orphans: OrphanGroup[] }>("/api/plugins/_orphans");
  return d.orphans;
}
