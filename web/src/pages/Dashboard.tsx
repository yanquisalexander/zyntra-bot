import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  CircleAlert,
  PlugZap,
  Power,
  PowerOff,
  Puzzle,
  RefreshCw,
  Server,
  Wifi,
  ArrowRight,
} from "lucide-react";
import { api, bootstrap } from "@/lib/api";
import { formatUptime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertError,
  StatusBadge,
  IconBox,
  Waved,
  statusTone,
  type Tone,
} from "@/components/common";

interface BotStatus {
  connected: boolean;
  tag: string | null;
  guilds: number;
  ping: number;
  /** discord.js Client.uptime — milisegundos desde READY */
  uptime: number;
  hasToken?: boolean;
}

interface Plugin {
  name: string;
  displayName: string;
  status: string;
  enabled: boolean;
  lastError?: string;
}

export default function Dashboard() {
  // Estado inicial del HTML inyectado por el servidor (pinta al instante).
  const boot = bootstrap();
  const [user] = useState<{ username: string } | null>((boot.user as { username: string } | null) ?? null);
  const [bot, setBot] = useState<BotStatus | null>(boot.bot ?? null);
  const [plugins, setPlugins] = useState<Plugin[]>(boot.plugins ?? []);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(!boot.bot);
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [guildId, setGuildId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [b, p, cfg] = await Promise.all([
        api<BotStatus>("/api/bot/status"),
        api<{ plugins: Plugin[] }>("/api/plugins").catch(() => ({ plugins: [] as Plugin[] })),
        api<{ config: Record<string, unknown> }>("/api/config").catch(() => ({ config: {} as Record<string, unknown> })),
      ]);
      setBot(b);
      setPlugins(p.plugins);
      setGuildId(typeof cfg.config.guildId === "string" ? cfg.config.guildId : null);
      setErr("");
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const active = plugins.filter((p) => p.status === "active" && !p.lastError).length;
  const stale = plugins.filter((p) => p.status === "active" && !!p.lastError).length;
  const errors = plugins.filter((p) => p.status === "error").length + stale;
  const disabled = plugins.filter((p) => !p.enabled).length;

  const connect = async (on: boolean) => {
    setBusy(on ? "connect" : "disconnect");
    setErr("");
    try {
      await api(on ? "/api/bot/connect" : "/api/bot/disconnect", { method: "POST" });
      await refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Héroe */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <Badge variant={bot?.connected ? "success" : "secondary"} className="mb-3">
            <span className={`size-1.5 rounded-full ${bot?.connected ? "bg-[#00d4aa]" : "bg-zinc-500"}`} />
            {bot?.connected ? "En línea" : "Apagado"}
          </Badge>
          <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">
            Hola{user ? (
              <>
                , <Waved stroke="#f72585">{user.username}</Waved>
              </>
            ) : (
              <> 👋</>
            )}
          </h1>
          <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            {bot?.connected
              ? `${bot.tag ?? "Tu bot"} está funcionando en ${bot.guilds} ${bot.guilds === 1 ? "servidor" : "servidores"} con ${active} ${active === 1 ? "plugin activo" : "plugins activos"}.`
              : "El bot está apagado. Enciéndelo y a jugar."}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={refresh}>
            <RefreshCw className="size-4" />
            Actualizar
          </Button>
          {bot?.connected ? (
            <Button variant="outline" disabled={busy !== null} onClick={() => connect(false)}>
              <PowerOff className="size-4" />
              {busy === "disconnect" ? "Apagando…" : "Apagar"}
            </Button>
          ) : (
            <Button disabled={busy !== null} onClick={() => connect(true)}>
              <Power className="size-4" />
              {busy === "connect" ? "Encendiendo…" : "Encender bot"}
            </Button>
          )}
        </div>
      </div>

      {err && <AlertError message={err} />}

      {guildId === "" && (
        <Link
          to="/config"
          className="flex items-center gap-3 rounded-2xl border border-[#ffb70033] bg-[#ffb70011] px-4 py-3.5 text-sm font-bold text-[#ffb700] transition-colors hover:border-[#ffb70066]"
        >
          <Server className="size-5 shrink-0" strokeWidth={2.5} />
          <span>
            El bot aún no tiene servidor asignado: responde en todos.{" "}
            <span className="underline">Elige el servidor →</span>
          </span>
        </Link>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          index={0}
          tone={bot?.connected ? "mint" : "gray"}
          icon={<Wifi className="size-5" strokeWidth={2.5} />}
          label="Conexión"
          loading={loading}
          value={bot ? (bot.connected ? (bot.tag ?? "En línea") : "Apagado") : "…"}
          hint={bot?.connected ? `Responde en ${bot.ping} ms, encendido hace ${formatUptime(bot.uptime / 1000)}` : undefined}
        />
        <StatCard
          index={1}
          tone="blurple"
          icon={<Server className="size-5" strokeWidth={2.5} />}
          label="Servidores"
          loading={loading}
          value={bot ? String(bot.guilds) : "…"}
          hint="Donde está metido"
        />
        <StatCard
          index={2}
          tone="violet"
          icon={<Puzzle className="size-5" strokeWidth={2.5} />}
          label="Plugins activos"
          loading={loading}
          value={String(active)}
          hint={`${plugins.length} en total, ${disabled} descansando`}
        />
        <StatCard
          index={3}
          tone={errors > 0 ? "red" : "gray"}
          icon={<CircleAlert className="size-5" strokeWidth={2.5} />}
          label="Con errores"
          loading={loading}
          value={String(errors)}
          hint={errors > 0 ? "Échales un ojo abajo" : "Todo en orden ✨"}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Plugins */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Tus plugins</CardTitle>
                <CardDescription>Cómo van ahora mismo</CardDescription>
              </div>
              <Link to="/plugins" className="text-sm font-extrabold text-[#8b93ff] hover:underline">
                Ver todos
              </Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {loading ? (
              <>
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
              </>
            ) : plugins.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
                <p className="font-display text-lg font-semibold">Sin plugins todavía</p>
                <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
                  Crea el primero y dale vida al bot.
                </p>
                <Link to="/plugins">
                  <Button size="sm" className="mt-3">
                    Crear uno
                  </Button>
                </Link>
              </div>
            ) : (
              plugins.slice(0, 5).map((p) => (
                <Link
                  key={p.name}
                  to={`/plugins/${encodeURIComponent(p.name)}`}
                  className="flex items-center gap-3.5 rounded-xl border border-border bg-[#1a1a1a] p-4 transition-colors hover:border-[#3a3a3a] hover:bg-[#202020]"
                >
                  <IconBox tone={statusTone(p.status)}>
                    <PlugZap className="size-5" strokeWidth={2.5} />
                  </IconBox>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-extrabold">
                      {p.displayName || p.name}
                    </p>
                    {p.lastError ? (
                      <p className="truncate text-xs font-bold text-[#ff7a78]" title={p.lastError}>
                        {p.status === "active" ? "⚠ recarga falló, sigue anterior: " : ""}
                        {p.lastError.slice(0, 120)}
                      </p>
                    ) : (
                      <p className="truncate font-mono text-[11px] text-zinc-500">{p.name}</p>
                    )}
                  </div>
                  <StatusBadge status={p.status} />
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        {/* Accesos */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Atajos</CardTitle>
            <CardDescription>Lo que más vas a usar</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2.5">
            <QuickLink to="/plugins" tone="violet" icon={<Puzzle className="size-5" strokeWidth={2.5} />} title="Plugins" desc="Crea y activa sin apagar el bot" />
            <QuickLink to="/logs" tone="mint" icon={<Activity className="size-5" strokeWidth={2.5} />} title="Qué pasa en directo" desc="La actividad del bot, con buscador" />
            <QuickLink to="/config" tone="yellow" icon={<Server className="size-5" strokeWidth={2.5} />} title="Ajustes" desc="Símbolo de comandos y opciones" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  loading,
  tone,
  index = 0,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  loading?: boolean;
  tone: Tone;
  index?: number;
}) {
  return (
    <Card
      className="animate-page-item p-5"
      style={{ animationDelay: `${index * 70}ms` } as React.CSSProperties}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-extrabold text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="mt-2 h-9 w-24 rounded-lg" />
          ) : (
            <p className="tnum mt-1 truncate font-display text-4xl font-semibold tracking-tight">{value}</p>
          )}
          {hint && !loading && <p className="mt-1 truncate text-xs font-bold text-muted-foreground">{hint}</p>}
        </div>
        <IconBox tone={tone}>{icon}</IconBox>
      </div>
    </Card>
  );
}

function QuickLink({ to, tone, icon, title, desc }: { to: string; tone: Tone; icon: React.ReactNode; title: string; desc: string }) {
  return (
    <Link
      to={to}
      className="group flex items-center gap-3.5 rounded-xl border border-border bg-[#1a1a1a] p-4 transition-colors hover:border-[#3a3a3a] hover:bg-[#202020]"
    >
      <IconBox tone={tone}>{icon}</IconBox>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-extrabold">{title}</span>
        <span className="block truncate text-xs font-bold text-muted-foreground">{desc}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-300" />
    </Link>
  );
}
