import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Activity, Cpu, MemoryStick, RefreshCw, Timer, Zap } from "lucide-react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, StatusBadge } from "@/components/common";

interface MetricWindow {
  count: number;
  errors: number;
  avgMs: number;
  p95Ms: number;
  lastMs: number | null;
  lastOk: boolean | null;
  lastError?: string;
}

interface PluginMetrics {
  name: string;
  startupMs: number | null;
  command: MetricWindow;
  http: MetricWindow;
  job: MetricWindow;
  rssMb: number;
  heapMb: number;
  cpuPercent: number;
  updatedAt: string;
}

interface Plugin {
  name: string;
  displayName: string;
  status: string;
  enabled: boolean;
  metrics?: PluginMetrics | null;
}

const OPERATIONS = [
  { key: "command", label: "Comandos" },
  { key: "http", label: "HTTP" },
  { key: "job", label: "Tareas" },
] as const;

export default function Metrics() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [devModeEnabled, setDevModeEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [pluginData, configData] = await Promise.all([
        api<{ plugins: Plugin[] }>("/api/plugins"),
        api<{ config: Record<string, unknown> }>("/api/config"),
      ]);
      setPlugins(pluginData.plugins ?? []);
      setDevModeEnabled(configData.config.devModeEnabled === true);
      setUpdatedAt(new Date());
      setError("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const totals = useMemo(() => {
    const metrics = plugins.map((p) => p.metrics).filter((m): m is PluginMetrics => !!m);
    return {
      active: plugins.filter((p) => p.status === "active").length,
      calls: metrics.reduce((sum, m) => sum + m.command.count + m.http.count + m.job.count, 0),
      errors: metrics.reduce((sum, m) => sum + m.command.errors + m.http.errors + m.job.errors, 0),
      process: metrics[0] ?? null,
    };
  }, [plugins]);

  if (devModeEnabled === null) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Comprobando DEV Mode…</p>;
  }
  if (devModeEnabled === false) return <Navigate to="/plugins" replace />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Métricas"
        description="Actividad reciente de plugins y consumo del proceso del bot. Actualización cada 5 segundos."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="violet"><Activity className="size-3" />DEV Mode</Badge>
            <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
              Actualizar
            </Button>
          </div>
        }
      />

      {error && (
        <div role="alert" className="rounded-xl border border-[#ff5e5b33] bg-[#ff5e5b11] px-4 py-3 text-sm text-[#ff7a78]">
          No se pudieron actualizar las métricas: {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <SummaryCard icon={<Zap />} label="Plugins activos" value={`${totals.active} / ${plugins.length}`} />
        <SummaryCard icon={<Activity />} label="Operaciones registradas" value={totals.calls.toLocaleString()} />
        <SummaryCard icon={<Cpu />} label="CPU media del proceso" value={totals.process ? `${totals.process.cpuPercent}%` : "—"} />
        <SummaryCard icon={<MemoryStick />} label="Memoria RSS del proceso" value={totals.process ? `${totals.process.rssMb} MB` : "—"} />
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Rendimiento por plugin</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Ventana de hasta 200 ejecuciones por tipo. {totals.errors > 0 && <span className="text-[#ff7a78]">{totals.errors} errores registrados.</span>}
            </p>
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {updatedAt ? `Actualizado ${updatedAt.toLocaleTimeString()}` : "Cargando…"}
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {loading && plugins.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">Cargando métricas…</p>
          ) : plugins.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">Todavía no hay plugins para medir.</p>
          ) : (
            <div className="divide-y divide-border">
              {plugins.map((plugin) => (
                <section key={plugin.name} className="px-4 py-4 sm:px-5">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <h2 className="truncate text-sm font-bold">{plugin.displayName || plugin.name}</h2>
                      <span className="font-mono text-[11px] text-zinc-500">{plugin.name}</span>
                    </div>
                    <StatusBadge status={plugin.status} />
                  </div>
                  {plugin.metrics ? (
                    <>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        {OPERATIONS.map(({ key, label }) => (
                          <OperationMetric key={key} label={label} metric={plugin.metrics![key]} />
                        ))}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><MemoryStick className="size-3" /> {plugin.metrics.rssMb} MB RSS</span>
                        <span>{plugin.metrics.heapMb} MB heap</span>
                        <span><Cpu className="mr-1 inline size-3" />{plugin.metrics.cpuPercent}% CPU</span>
                        <span><Timer className="mr-1 inline size-3" />Inicio {plugin.metrics.startupMs == null ? "—" : `${plugin.metrics.startupMs} ms`}</span>
                        <span className="text-zinc-600" title="Uso del proceso completo, compartido por los plugins">uso compartido del proceso</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">Sin ejecuciones registradas todavía.</p>
                  )}
                </section>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4 sm:p-5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#a78bfa33] bg-[#a78bfa11] text-[#a78bfa] [&>svg]:size-4">{icon}</span>
        <div className="min-w-0">
          <p className="truncate text-[11px] text-muted-foreground">{label}</p>
          <p className="font-mono text-lg font-semibold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function OperationMetric({ label, metric }: { label: string; metric: MetricWindow }) {
  return (
    <div className="rounded-xl border border-border bg-[#111] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold">{label}</p>
        <Badge variant={metric.errors > 0 ? "warning" : "secondary"}>{metric.count} ejecuciones</Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
        <span>media {metric.avgMs} ms</span>
        <span>p95 {metric.p95Ms} ms</span>
        <span className={metric.errors > 0 ? "text-[#ff7a78]" : ""}>{metric.errors} errores</span>
        {metric.lastMs != null && <span>última {metric.lastMs} ms {metric.lastOk === false ? "· falló" : "· ok"}</span>}
      </div>
      {metric.lastError && <p className="mt-1 truncate text-[11px] text-[#ff7a78]" title={metric.lastError}>{metric.lastError}</p>}
    </div>
  );
}
