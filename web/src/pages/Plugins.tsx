import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Puzzle, RefreshCw, RotateCcw, Search, Trash2, Power, PowerOff, Code2, X, Command, PartyPopper, HandMetal } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeader,
  AlertError,
  StatusBadge,
  EmptyState,
  IconBox,
  statusText,
  statusTone,
} from "@/components/common";

interface PluginCommand {
  /** Nombre sin prefijo (`!hola` → `hola`). */
  name: string;
  description?: string;
  /** True si otro plugin cargado antes ya registró el mismo comando (este pierde). */
  conflict?: boolean;
  /** Plugin que responde al comando cuando hay duplicado. */
  owner?: string;
  /** También registrado como slash command `/nombre`. */
  slash?: boolean;
}

interface PluginRoute {
  method: "GET" | "POST";
  /** Subruta (`eventsub` en `/plugin-routes/twitch/eventsub`). */
  path: string;
  raw?: boolean;
}

interface Plugin {
  /** ID estable: carpeta en `data/plugins/`. */
  name: string;
  /** Nombre visible (`definePlugin({ name })`, o el ID). */
  displayName: string;
  version: string;
  status: string;
  enabled: boolean;
  core?: boolean;
  lastError?: string;
  lastLoadedAt?: string;
  commands?: PluginCommand[];
  routes?: PluginRoute[];
}

const displayOf = (p: Pick<Plugin, "name" | "displayName">) => p.displayName || p.name;

/** Convierte "Mi Súper Plugin" → "mi-super-plugin" (id de carpeta). */
const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 32);

type TemplateId = "hola" | "ping" | "welcome";

const TEMPLATES: { id: TemplateId; icon: typeof Command; title: string; desc: string }[] = [
  { id: "hola", icon: HandMetal, title: "Hola", desc: "Comando !hola mínimo para empezar." },
  { id: "ping", icon: Command, title: "Ping", desc: "Comando !ping con latencia." },
  { id: "welcome", icon: PartyPopper, title: "Bienvenida", desc: "Saluda al entrar + config.toml." },
];

export default function Plugins() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [prefix, setPrefix] = useState("!");
  const [query, setQuery] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [closing, setClosing] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [template, setTemplate] = useState<TemplateId>("hola");
  const [createErr, setCreateErr] = useState("");

  const refresh = async () => {
    try {
      const d = await api<{ plugins: Plugin[]; prefix?: string }>("/api/plugins");
      setPlugins(d.plugins);
      if (typeof d.prefix === "string" && d.prefix) setPrefix(d.prefix);
      setErr("");
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return plugins;
    return plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        displayOf(p).toLowerCase().includes(q) ||
        p.status.toLowerCase().includes(q) ||
        statusText(p.status).toLowerCase().includes(q) ||
        (p.commands ?? []).some((c) => c.name.toLowerCase().includes(q)),
    );
  }, [plugins, query]);

  const act = async (path: string, label: string, method = "POST") => {
    setBusy(label);
    setErr("");
    try {
      await api(path, { method });
      await refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  const openCreate = () => {
    setDisplayName("");
    setSlug("");
    setSlugTouched(false);
    setTemplate("hola");
    setCreateErr("");
    setClosing(false);
    setShowCreate(true);
  };

  const closeCreate = () => {
    if (busy === "create") return;
    setClosing(true);
    setTimeout(() => {
      setShowCreate(false);
      setClosing(false);
    }, 160);
  };

  // Cerrar con Escape (el backdrop no recibe foco, así que va a nivel ventana).
  useEffect(() => {
    if (!showCreate) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCreate();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCreate, busy]);

  const onDisplayName = (v: string) => {
    setDisplayName(v);
    if (!slugTouched) setSlug(slugify(v));
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = slug.trim();
    const label = displayName.trim();
    if (!label) {
      setCreateErr("Ponle un nombre visible al plugin.");
      return;
    }
    if (!/^[a-z0-9-_]{2,32}$/.test(id)) {
      setCreateErr("El id debe tener 2-32 caracteres (a-z, 0-9, -, _).");
      return;
    }
    if (plugins.some((p) => p.name === id)) {
      setCreateErr(`Ya existe un plugin con el id "${id}".`);
      return;
    }
    setBusy("create");
    setCreateErr("");
    try {
      await api("/api/plugins", {
        method: "POST",
        body: JSON.stringify({ name: id, displayName: label, template }),
      });
      setShowCreate(false);
      await refresh();
    } catch (e2) {
      setCreateErr(String(e2 instanceof Error ? e2.message : e2));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (pname: string) => {
    if (!confirm(`¿Borrar "${pname}" para siempre? Se pierden sus archivos.`)) return;
    await act(`/api/plugins/${encodeURIComponent(pname)}`, `del-${pname}`, "DELETE");
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Plugins"
        description={`${plugins.length} en total. Los cambios se aplican sin apagar el bot.`}
        actions={
          <Button variant="secondary" onClick={refresh}>
            <RefreshCw className="size-4" />
            Actualizar lista
          </Button>
        }
      />

      {err && <AlertError message={err} />}

      {/* Crear + buscar */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <Button onClick={openCreate} className="shrink-0 self-start">
          <Plus className="size-4" />
          Crear plugin
        </Button>
        <div className="relative sm:w-72">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar…" className="pl-9" />
        </div>
      </div>

      {showCreate && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px] transition-opacity duration-150 ${
            closing ? "opacity-0" : "opacity-100 animate-fade-in"
          }`}
          onClick={closeCreate}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Crear plugin"
            className={`w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-xl transition-all duration-150 ${
              closing ? "scale-95 opacity-0" : "animate-fade-in-down"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-2">
              <div>
                <h2 className="font-display text-xl font-semibold tracking-tight">Crear plugin</h2>
                <p className="mt-1 text-sm text-muted-foreground">El id se genera solo, puedes ajustarlo.</p>
              </div>
              <Button variant="outline" size="xs" onClick={closeCreate} disabled={busy === "create"}>
                <X className="size-3.5" />
              </Button>
            </div>
            <form onSubmit={create} className="space-y-4">
              <div>
                <label htmlFor="plugin-display" className="mb-1.5 block text-sm font-bold">
                  Nombre del plugin
                </label>
                <Input
                  id="plugin-display"
                  value={displayName}
                  onChange={(e) => onDisplayName(e.target.value)}
                  placeholder="Mi Súper Plugin"
                  maxLength={60}
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="plugin-slug" className="mb-1.5 block text-sm font-bold">
                  ID <span className="font-normal text-muted-foreground">(carpeta, único)</span>
                </label>
                <div className="flex gap-2">
                  <Input
                    id="plugin-slug"
                    value={slug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 32));
                    }}
                    placeholder="mi-super-plugin"
                    className="font-mono"
                    maxLength={32}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setSlugTouched(false);
                      setSlug(slugify(displayName));
                    }}
                    title="Regenerar desde el nombre"
                  >
                    <RotateCcw className="size-4" />
                  </Button>
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-sm font-bold">Template</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTemplate(t.id)}
                      aria-pressed={template === t.id}
                      className={`rounded-xl border p-3 text-left transition-colors ${
                        template === t.id
                          ? "border-[#8b93ff] bg-[#8b93ff11]"
                          : "border-border hover:border-[#3a3a3a]"
                      }`}
                    >
                      <t.icon className="mb-1.5 size-4 text-muted-foreground" />
                      <p className="text-sm font-extrabold">{t.title}</p>
                      <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{t.desc}</p>
                    </button>
                  ))}
                </div>
              </div>
              {createErr && <AlertError message={createErr} />}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={closeCreate} disabled={busy === "create"}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={busy === "create" || !displayName.trim() || !slug.trim()}>
                  <Plus className="size-4" />
                  {busy === "create" ? "Creando…" : "Crear"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Skeleton className="h-36 w-full rounded-2xl" />
          <Skeleton className="h-36 w-full rounded-2xl" />
          <Skeleton className="h-36 w-full rounded-2xl" />
          <Skeleton className="h-36 w-full rounded-2xl" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          emoji="🔌"
          tone="violet"
          title={query ? "Nada por aquí" : "Todavía no hay plugins"}
          description={
            query
              ? `Nada coincide con "${query}". Prueba con otra palabra.`
              : "Crea el primero arriba y dale superpoderes al bot. 🚀"
          }
        />
      ) : (
        <>
          {/* Cards en móvil/tablet, tabla en desktop */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:hidden">
            {filtered.map((p) => (
              <PluginCard key={p.name} p={p} prefix={prefix} busy={busy} onAct={act} onRemove={remove} />
            ))}
          </div>

          <Card className="hidden overflow-hidden xl:block">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-[#1a1a1a] text-xs font-extrabold text-muted-foreground">
                      <th className="px-5 py-3.5">Plugin</th>
                      <th className="px-4 py-3.5">Estado</th>
                      <th className="px-4 py-3.5">Comandos</th>
                      <th className="px-4 py-3.5">Nota</th>
                      <th className="px-4 py-3.5 text-right">Qué hacer</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filtered.map((p) => (
                      <tr key={p.name} className="transition-colors hover:bg-white/[0.02]">
                        <td className="px-5 py-3.5">
                          <Link
                            to={`/plugins/${encodeURIComponent(p.name)}`}
                            className="text-[15px] font-extrabold text-foreground hover:text-[#8b93ff] hover:underline"
                          >
                            {displayOf(p)}
                          </Link>
                          <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
                            {p.name} · v{p.version}
                            {p.core && (
                              <Badge variant="secondary" title="Viene con la app: solo ajustes y activar/desactivar">
                                Core
                              </Badge>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3.5">
                          <StatusBadge status={p.status} />
                        </td>
                        <td className="max-w-[240px] px-4 py-3.5">
                          {(p.commands ?? []).length === 0 && (p.routes ?? []).length === 0 ? (
                            <span className="text-xs font-normal text-zinc-600">—</span>
                          ) : (
                            <span className="flex flex-col gap-1.5">
                              {(p.commands ?? []).length > 0 && (
                                <CommandBadges commands={p.commands ?? []} prefix={prefix} />
                              )}
                              {(p.routes ?? []).length > 0 && (
                                <RouteBadges plugin={p.name} routes={p.routes ?? []} />
                              )}
                            </span>
                          )}
                        </td>
                        <td className="max-w-[280px] truncate px-4 py-3.5 text-xs font-bold text-[#ff7a78]" title={p.lastError ?? undefined}>
                          {p.lastError ? (
                            <>
                              {p.status === "active" && <span className="text-[#ffb700]">⚠ recarga falló, sigue anterior: </span>}
                              {p.lastError.slice(0, 100)}
                            </>
                          ) : (
                            <span className="font-normal text-zinc-600">todo bien ✨</span>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          <RowActions p={p} busy={busy} onAct={act} onRemove={remove} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

const MAX_VISIBLE_COMMANDS = 4;

function CommandBadges({ commands, prefix }: { commands: PluginCommand[]; prefix: string }) {
  if (commands.length === 0) return null;
  const visible = commands.slice(0, MAX_VISIBLE_COMMANDS);
  const rest = commands.slice(MAX_VISIBLE_COMMANDS);
  const labelOf = (c: PluginCommand) =>
    `${prefix}${c.name}${c.description ? ` — ${c.description}` : ""}${c.conflict && c.owner ? ` (duplicado: responde ${c.owner})` : ""}`;
  return (
    <span className="flex flex-wrap gap-1">
      {visible.map((c) => (
        <Badge
          key={c.name}
          variant={c.conflict ? "warning" : "outline"}
          className="font-mono"
          title={labelOf(c)}
        >
          {c.slash ? "/ " : ""}
          {c.conflict ? "⚠ " : ""}
          {prefix}
          {c.name}
        </Badge>
      ))}
      {rest.length > 0 && (
        <Badge
          variant={rest.some((c) => c.conflict) ? "warning" : "secondary"}
          className="font-mono"
          title={rest.map(labelOf).join("\n")}
        >
          +{rest.length}
        </Badge>
      )}
    </span>
  );
}

function RouteBadges({ plugin, routes }: { plugin: string; routes: PluginRoute[] }) {
  if (routes.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {routes.map((rt) => (
        <Badge
          key={`${rt.method} ${rt.path}`}
          variant="violet"
          className="font-mono"
          title={`/plugin-routes/${plugin}/${rt.path}${rt.raw ? " (bytes crudos)" : ""}`}
        >
          🌐 {rt.method} /{rt.path}
        </Badge>
      ))}
    </span>
  );
}

function PluginCard({
  p,
  prefix,
  busy,
  onAct,
  onRemove,
}: {
  p: Plugin;
  prefix: string;
  busy: string | null;
  onAct: (path: string, label: string, method?: string) => void;
  onRemove: (name: string) => void;
}) {
  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <IconBox tone={statusTone(p.status)}>
          <Puzzle className="size-5" strokeWidth={2.5} />
        </IconBox>
        <StatusBadge status={p.status} />
      </div>
      <Link
        to={`/plugins/${encodeURIComponent(p.name)}`}
        className="block truncate font-display text-xl font-semibold tracking-tight hover:text-[#8b93ff] hover:underline"
      >
        {displayOf(p)}
      </Link>
      <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">{p.name}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge variant="outline" className="font-mono">
          v{p.version}
        </Badge>
        <Badge variant="secondary">{p.enabled ? "activado" : "descansando"}</Badge>
        {p.core && <Badge variant="secondary" title="Viene con la app: solo ajustes y activar/desactivar">Core</Badge>}
      </div>
      {(p.commands ?? []).length > 0 && (
        <div className="mt-2.5">
          <CommandBadges commands={p.commands ?? []} prefix={prefix} />
        </div>
      )}
      {(p.routes ?? []).length > 0 && (
        <div className="mt-2">
          <RouteBadges plugin={p.name} routes={p.routes ?? []} />
        </div>
      )}
      {p.lastError && (
        <p className="mt-3 truncate rounded-xl bg-[#ff5e5b11] px-3 py-2 font-mono text-[11px] text-[#ff7a78]" title={p.lastError}>
          {p.status === "active" ? "⚠ recarga falló, sigue anterior: " : ""}
          {p.lastError.slice(0, 140)}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-1.5">
        <Button
          variant="secondary"
          size="xs"
          disabled={busy !== null}
          onClick={() => onAct(`/api/plugins/${encodeURIComponent(p.name)}/reload`, `reload-${p.name}`)}
        >
          <RotateCcw className="size-3.5" />
          Recargar
        </Button>
        {p.enabled ? (
          <Button
            variant="outline"
            size="xs"
            disabled={busy !== null}
            onClick={() => onAct(`/api/plugins/${encodeURIComponent(p.name)}/disable`, `dis-${p.name}`)}
          >
            <PowerOff className="size-3.5" />
            Apagar
          </Button>
        ) : (
          <Button
            variant="outline"
            size="xs"
            disabled={busy !== null}
            onClick={() => onAct(`/api/plugins/${encodeURIComponent(p.name)}/enable`, `en-${p.name}`)}
          >
            <Power className="size-3.5" />
            Encender
          </Button>
        )}
        <Link to={`/plugins/${encodeURIComponent(p.name)}`}>
          <Button variant="outline" size="xs">
            <Code2 className="size-3.5" />
            Editar
          </Button>
        </Link>
        {!p.core && (
          <Button variant="destructive" size="xs" disabled={busy !== null} onClick={() => onRemove(p.name)}>
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </Card>
  );
}

function RowActions({
  p,
  busy,
  onAct,
  onRemove,
}: {
  p: Plugin;
  busy: string | null;
  onAct: (path: string, label: string, method?: string) => void;
  onRemove: (name: string) => void;
}) {
  const dis = busy !== null;
  return (
    <div className="flex justify-end gap-1.5">
      <Button variant="secondary" size="xs" disabled={dis} onClick={() => onAct(`/api/plugins/${encodeURIComponent(p.name)}/reload`, `reload-${p.name}`)}>
        <RotateCcw className="size-3.5" />
        Recargar
      </Button>
      {p.enabled ? (
        <Button variant="outline" size="xs" disabled={dis} onClick={() => onAct(`/api/plugins/${encodeURIComponent(p.name)}/disable`, `dis-${p.name}`)}>
          Apagar
        </Button>
      ) : (
        <Button variant="outline" size="xs" disabled={dis} onClick={() => onAct(`/api/plugins/${encodeURIComponent(p.name)}/enable`, `en-${p.name}`)}>
          Encender
        </Button>
      )}
      <Link to={`/plugins/${encodeURIComponent(p.name)}`}>
        <Button variant="outline" size="xs">
          Editar
        </Button>
      </Link>
      {!p.core && (
        <Button variant="destructive" size="xs" disabled={dis} onClick={() => onRemove(p.name)}>
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
