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
