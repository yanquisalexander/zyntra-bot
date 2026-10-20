import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import {
  Bot,
  CalendarClock,
  LayoutDashboard,
  Puzzle,
  Settings2,
  ScrollText,
  Menu,
  X,
  LogOut,
  ChevronRight,
  Users,
  Webhook,
  Activity,
} from "lucide-react";
import { api, bootstrap, discordAvatarUrl, type BootstrapPlugin, type PanelUser } from "@/lib/api";
import Setup from "@/pages/Setup";
import { uiIcon, type UiTabListItem } from "@/lib/ui";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/plugins", label: "Plugins", icon: Puzzle, end: false },
  { to: "/jobs", label: "Tareas", icon: CalendarClock, end: true },
  { to: "/config", label: "Configuración", icon: Settings2, end: true },
  { to: "/logs", label: "Logs", icon: ScrollText, end: true },
];

function useBotStatus() {
  // Estado inicial del HTML inyectado por el servidor (sin esperar a la API).
  const [bot, setBot] = useState<{ connected: boolean; tag: string | null; hasToken?: boolean } | null>(
    (bootstrap().bot as { connected: boolean; tag: string | null; hasToken?: boolean } | null) ?? null,
  );
  useEffect(() => {
    let alive = true;
    api<{ connected: boolean; tag: string | null; hasToken?: boolean }>("/api/bot/status")
      .then((d) => alive && setBot(d))
      .catch(() => undefined);
    const t = setInterval(() => {
      api<{ connected: boolean; tag: string | null; hasToken?: boolean }>("/api/bot/status")
        .then((d) => alive && setBot(d))
        .catch(() => undefined);
    }, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return bot;
}

export default function AppShell() {
  const boot = bootstrap();
  const bypassAdminCheck = boot.flags?.bypassAdminServerCheck ?? false;
  const [user, setUser] = useState<PanelUser | null>(boot.user ?? null);
  const [open, setOpen] = useState(false);
  const [authDone, setAuthDone] = useState(!!boot.user);
  const [devModeEnabled, setDevModeEnabled] = useState(false);
  const location = useLocation();
  const bot = useBotStatus();
  const uiTabs = useUiTabs(!!user);
  const routeCount = usePluginRouteCount(!!user);
  const setupBlocked = useSetupBlocked(!!user, bot?.hasToken);

  useEffect(() => {
    api<{ user: PanelUser | null }>("/api/auth/me")
      .then((d) => setUser(d.user))
      .catch(() => undefined)
      .finally(() => setAuthDone(true));
  }, []);

  useEffect(() => {
    let alive = true;
    const syncConfig = (config?: Record<string, unknown>) => {
      if (config) {
        setDevModeEnabled(config.devModeEnabled === true);
        return;
      }
      api<{ config: Record<string, unknown> }>("/api/config")
        .then((d) => alive && setDevModeEnabled(d.config.devModeEnabled === true))
        .catch(() => undefined);
    };
    const onConfigUpdated = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      syncConfig(detail);
    };
    syncConfig();
    window.addEventListener("zyntra:config-updated", onConfigUpdated);
    return () => {
      alive = false;
      window.removeEventListener("zyntra:config-updated", onConfigUpdated);
    };
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.href = "/api/auth/login";
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <Link to="/" className="flex items-center gap-2.5 px-5 pt-5 pb-4">
        <div className="flex size-10 shrink-0 items-center justify-center bg-[#a78bfa] text-[#1a1033] animate-morph">
          <Bot className="size-5" strokeWidth={2.5} />
        </div>
        <div className="leading-tight">
          <p className="font-display text-[19px] font-semibold tracking-tight">
            Zyntra<span className="text-[#a78bfa]">Bot</span>
          </p>
          <p className="text-xs font-bold text-muted-foreground">Panel de control</p>
        </div>
      </Link>

      {/* Bot status */}
      <div className="px-3 pb-3">
        <div
          className={cn(
            "flex items-center gap-2.5 rounded-xl border px-3 py-2.5",
            bot?.connected
              ? "border-[#00d4aa33] bg-[#00d4aa11]"
              : "border-[#2e2e2e] bg-[#1a1a1a]",
          )}
        >
          <span
            className={cn(
              "size-2.5 shrink-0 rounded-full",
              bot?.connected ? "bg-[#00d4aa]" : "bg-zinc-600",
            )}
          />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13px] font-extrabold">{bot?.connected ? (bot.tag ?? "En línea") : "Apagado"}</p>
            <p className="text-[11px] font-bold text-muted-foreground">
              {bot?.connected ? "Funcionando" : "Desconectado"}
            </p>
          </div>
          <Badge variant={bot?.connected ? "success" : "secondary"}>
            {bot?.connected ? "en línea" : "off"}
          </Badge>
        </div>
      </div>

      <Separator className="mx-3 w-auto" />

      {/* Nav */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        {[...NAV, ...(devModeEnabled ? [{ to: "/metrics", label: "Métricas", icon: Activity, end: true }] : [])].map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm font-bold transition-colors duration-150",
                isActive
                  ? "border-[#5865f233] bg-[#5865f211] text-white"
                  : "text-muted-foreground hover:bg-[#1a1a1a] hover:text-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg border",
                    isActive
                      ? "border-[#5865f240] bg-[#5865f220] text-[#8b93ff]"
                      : "border-[#2e2e2e] bg-[#1a1a1a] text-zinc-500 group-hover:text-zinc-300",
                  )}
                >
                  <item.icon className="size-4" strokeWidth={2.5} />
                </span>
                {item.label}
                {isActive && <ChevronRight className="ml-auto size-4 text-[#8b93ff]" />}
              </>
            )}
          </NavLink>
        ))}
        {routeCount > 0 && (
          <NavLink
            to="/routes"
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm font-bold transition-colors duration-150",
                isActive
                  ? "border-[#00d4aa33] bg-[#00d4aa11] text-white"
                  : "text-muted-foreground hover:bg-[#1a1a1a] hover:text-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg border",
                    isActive
                      ? "border-[#00d4aa40] bg-[#00d4aa20] text-[#00d4aa]"
                      : "border-[#2e2e2e] bg-[#1a1a1a] text-zinc-500 group-hover:text-zinc-300",
                  )}
                >
                  <Webhook className="size-4" strokeWidth={2.5} />
                </span>
                Rutas
                <Badge variant="secondary" className="ml-auto font-mono">
                  {routeCount}
                </Badge>
                {isActive && <ChevronRight className="size-4 text-[#00d4aa]" />}
              </>
            )}
          </NavLink>
        )}
        {uiTabs.length > 0 && (
          <>
            <p className="px-3 pt-4 pb-1 text-[11px] font-bold tracking-wide text-zinc-600">
              Plugins
            </p>
            {uiTabs.map((t) => {
              const Icon = uiIcon(t.icon);
              const to = `/p/${encodeURIComponent(t.plugin)}/${encodeURIComponent(t.id)}`;
              return (
                <NavLink
                  key={`${t.plugin}:${t.id}`}
                  to={to}
                  className={({ isActive }) =>
                    cn(
                      "group flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm font-bold transition-colors duration-150",
                      isActive
                        ? "border-[#a78bfa33] bg-[#a78bfa11] text-white"
                        : "text-muted-foreground hover:bg-[#1a1a1a] hover:text-foreground",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={cn(
                          "flex size-8 items-center justify-center rounded-lg border",
                          isActive
                            ? "border-[#a78bfa40] bg-[#a78bfa20] text-[#a78bfa]"
                            : "border-[#2e2e2e] bg-[#1a1a1a] text-zinc-500 group-hover:text-zinc-300",
                        )}
                      >
                        <Icon className="size-4" strokeWidth={2.5} />
                      </span>
                      <span className="min-w-0 truncate">{t.label}</span>
                      {isActive && <ChevronRight className="ml-auto size-4 shrink-0 text-[#a78bfa]" />}
                    </>
                  )}
                </NavLink>
              );
            })}
          </>
        )}
      </nav>

      {/* User */}
      <div className="border-t border-border p-3">
        {user ? (
          <div className="flex items-center gap-2.5 rounded-xl bg-[#1a1a1a] px-2.5 py-2">
            <UserAvatar user={user} />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[13px] font-extrabold">{user.username}</p>
              <p className="text-[11px] font-bold text-muted-foreground">Administrador</p>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={logout} title="Cerrar sesión">
              <LogOut className="size-4" />
            </Button>
          </div>
        ) : (
          <Button className="w-full" onClick={() => (window.location.href = "/login")}>
            Entrar con Discord
          </Button>
        )}
      </div>
    </div>
  );

  // Sin sesión no se pinta el panel: a la login page (en producción el
  // servidor ya redirige antes; esto cubre el dev con HMR y sesiones caducadas).
  if (authDone && !user) return <Navigate to="/login" replace />;

  // Setup incompleto (sin token o sin admins): wizard en vez de la app.
  // Nunca en carga (null) y nunca en /setup para no hacer loop.
  if (setupBlocked && location.pathname !== "/setup") return <Setup mode="gate" />;

  return (
    <div className="min-h-screen bg-background font-sans text-foreground lg:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-[280px] shrink-0 border-r border-border bg-[#101010] lg:block">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/70 backdrop-blur-sm transition-opacity lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setOpen(false)}
      />
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-[300px] max-w-[85vw] border-r border-border bg-[#101010] transition-transform duration-200 ease-out lg:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {sidebar}
      </aside>

      {/* Main column */}
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur-md">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setOpen(!open)}>
              {open ? <X className="size-5" /> : <Menu className="size-5" />}
            </Button>
            <Breadcrumb path={location.pathname} />
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden items-center gap-2 rounded-full border border-[#2e2e2e] bg-[#1a1a1a] px-3 py-1.5 text-xs font-bold text-muted-foreground sm:flex">
                <span className={cn("size-2 rounded-full", bot?.connected ? "bg-[#00d4aa]" : "bg-zinc-600")} />
                {bot?.connected ? (bot.tag ?? "en línea") : "desconectado"}
              </span>
              {user && (
                <span className="hidden text-sm font-bold text-muted-foreground md:block">
                  Hola, <span className="font-extrabold text-foreground">{user.username}</span> 👋
                </span>
              )}
            </div>
          </div>
        </header>

        {/* Content */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {bypassAdminCheck && (
            <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-[#ffb70033] bg-[#ffb70011] px-4 py-3 text-[13px] leading-relaxed text-[#ffb700]">
              <Users className="mt-0.5 size-4 shrink-0" />
              <p>
                <span className="font-extrabold">Modo compartido activado:</span> cualquier admin del
                panel puede configurar el bot para servidores donde no es admin.
                Solo gente de total confianza.
              </p>
            </div>
          )}
          <div key={location.pathname} className="animate-page-in">
            <Outlet />
          </div>
        </main>

        <footer className="px-6 py-6">
          <p className="mx-auto max-w-6xl text-center text-xs font-bold text-zinc-600">
            Hecho de noche, con ☕ por Alexitoo — si algo se rompe, es una feature.
          </p>
        </footer>
      </div>
    </div>
  );
}

/**
 * Bloqueo de primer setup: vía rápida por bootstrap (sin token = bloqueado
 * al instante) + confirmación por API (cubre admins vacíos). null = aún
 * cargando (no bloquea para no flashear el wizard).
 */
function useSetupBlocked(enabled: boolean, hasToken?: boolean) {
  const [blocked, setBlocked] = useState<boolean | null>(() => (hasToken === false ? true : null));
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      api<{ blocked: boolean }>("/api/setup/checks")
        .then((d) => alive && setBlocked(d.blocked))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return blocked;
}

/** Nº de endpoints públicos activos (`/plugin-routes/*`). Solo semilla + polling ligero. */
function usePluginRouteCount(enabled: boolean) {
  const countOf = (ps?: BootstrapPlugin[] | null) =>
    (ps ?? [])
      .filter((p) => p.status === "active")
      .reduce((n, p) => n + (p.routes ?? []).length, 0);
  const [count, setCount] = useState(() => countOf(bootstrap().plugins));
  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    let alive = true;
    const load = () =>
      api<{ plugins: BootstrapPlugin[] }>("/api/plugins")
        .then((d) => alive && setCount(countOf(d.plugins)))
        .catch(() => undefined);
    if (count === 0) load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return count;
}

function useUiTabs(enabled: boolean) {
  // Semilla del bootstrap (pinta al instante); el polling refresca
  // cuando se recarga/activa un plugin con tabs.
  const [tabs, setTabs] = useState<UiTabListItem[]>(() => bootstrap().uiTabs ?? []);
  useEffect(() => {
    if (!enabled) {
      setTabs([]);
      return;
    }
    let alive = true;
    const load = () =>
      api<{ tabs: UiTabListItem[] }>("/api/ui/tabs")
        .then((d) => alive && setTabs(d.tabs))
        .catch(() => undefined);
    // Solo refetch si el bootstrap no trajo nada (evita el flash de recarga).
    if (tabs.length === 0) load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return tabs;
}

function UserAvatar({ user }: { user: PanelUser }) {
  const [broken, setBroken] = useState(false);
  const url = broken ? null : discordAvatarUrl(user.discordId, user.avatar, 64);
  if (!url) {
    return (
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#a78bfa] font-display text-sm font-semibold text-[#1a1033] uppercase">
        {user.username.slice(0, 2)}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={user.username}
      width={36}
      height={36}
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="size-9 shrink-0 rounded-xl border border-[#2e2e2e] object-cover"
    />
  );
}

function Breadcrumb({ path }: { path: string }) {
  const parts = path.split("/").filter(Boolean);
  const label =
    parts.length === 0
      ? "Dashboard"
      : parts[0] === "routes"
        ? "Rutas"
        : parts[0] === "plugins" && parts[1]
          ? `Editar ${decodeURIComponent(parts[1])}`
          : parts[0] === "p" && parts[2]
            ? `Vista · ${decodeURIComponent(parts[2])}`
            : parts[0][0].toUpperCase() + parts[0].slice(1);
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="hidden font-bold text-muted-foreground sm:block">Panel</span>
      <ChevronRight className="hidden size-3.5 text-zinc-600 sm:block" />
      <span className="truncate font-display text-[17px] font-semibold tracking-tight">{label}</span>
    </div>
  );
}

export function ShellFallback({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
