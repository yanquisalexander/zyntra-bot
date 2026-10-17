import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, RefreshCw, Webhook } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, AlertError, EmptyState } from "@/components/common";

interface PluginRoute {
  method: "GET" | "POST";
  path: string;
  raw?: boolean;
}

interface Plugin {
  name: string;
  displayName: string;
  status: string;
  routes?: PluginRoute[];
}

interface PluginGroup {
  name: string;
  displayName: string;
  routes: PluginRoute[];
}

const displayOf = (p: Pick<Plugin, "name" | "displayName">) => p.displayName || p.name;
const fullPath = (plugin: string, path: string) => `/plugin-routes/${plugin}/${path}`;

export default function Routes() {
  const [groups, setGroups] = useState<PluginGroup[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const d = await api<{ plugins: Plugin[] }>("/api/plugins");
      setGroups(
        d.plugins
          .filter((p) => p.status === "active" && (p.routes ?? []).length > 0)
          .map((p) => ({ name: p.name, displayName: displayOf(p), routes: p.routes ?? [] }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      );
      setErr("");
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* portapapeles no disponible */
    }
  };

  const total = groups.reduce((n, g) => n + g.routes.length, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Rutas"
        description={
          total === 0
            ? "Endpoints públicos registrados por plugins."
            : `${total} endpoint${total === 1 ? "" : "s"} público${total === 1 ? "" : "s"} en ${groups.length} plugin${groups.length === 1 ? "" : "s"}. Sin sesión: son webhooks.`
        }
        actions={
          <Button variant="secondary" onClick={refresh}>
            <RefreshCw className="size-4" />
            Actualizar
          </Button>
        }
      />

      {err && <AlertError message={err} />}

      {loading ? (
        <div className="grid grid-cols-1 gap-4">
          <Skeleton className="h-32 w-full rounded-2xl" />
          <Skeleton className="h-32 w-full rounded-2xl" />
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          emoji="🌐"
          tone="violet"
          title="Ningún plugin expone rutas"
          description="Cuando un plugin registre endpoints con api.http, aparecerán aquí automáticamente."
          action={
            <Link to="/plugins">
              <Button size="sm">Ver plugins</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {groups.map((g) => (
            <Card key={g.name}>
              <CardContent className="p-5">
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-[#a78bfa33] bg-[#a78bfa11] text-[#a78bfa]">
                    <Webhook className="size-4" strokeWidth={2.5} />
                  </span>
                  <div className="min-w-0">
                    <Link
                      to={`/plugins/${encodeURIComponent(g.name)}`}
                      className="block truncate font-display text-lg font-semibold tracking-tight hover:text-[#8b93ff] hover:underline"
                    >
                      {g.displayName}
                    </Link>
                    <p className="truncate font-mono text-[11px] text-zinc-500">{g.name}</p>
                  </div>
                  <Badge variant="secondary" className="ml-auto shrink-0 font-mono">
                    {g.routes.length}
                  </Badge>
                </div>
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                  {g.routes.map((rt) => {
                    const full = fullPath(g.name, rt.path);
                    const key = `${rt.method} ${full}`;
                    const absolute = `${window.location.origin}${full}`;
                    return (
                      <li
                        key={key}
                        className="flex flex-wrap items-center gap-2 bg-[#141414] px-3.5 py-2.5"
                      >
                        <Badge variant={rt.method === "POST" ? "default" : "violet"} className="font-mono">
                          {rt.method}
                        </Badge>
                        <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground" title={full}>
                          {full}
                        </code>
                        {rt.raw && (
                          <Badge variant="warning" title="Recibe bytes crudos (firmas HMAC)">
                            raw
                          </Badge>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Copiar URL completa"
                          onClick={() => copy(key, absolute)}
                        >
                          {copied === key ? <Check className="size-4 text-[#00d4aa]" /> : <Copy className="size-4" />}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
