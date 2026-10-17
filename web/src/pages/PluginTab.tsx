import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { uiIcon } from "@/lib/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertError, EmptyState, PageHeader } from "@/components/common";

type Width = "full" | "half";

interface Base {
  id: string;
  title?: string;
  width: Width;
  refreshMs?: number;
  error?: string;
}

type Widget =
  | (Base & { kind: "stat"; value: string; suffix?: string; icon?: string })
  | (Base & { kind: "table"; columns: { key: string; label: string; mono?: boolean }[]; rows: string[][]; empty?: string })
  | (Base & { kind: "list"; items: string[]; empty?: string })
  | (Base & { kind: "line" | "bars"; series: number[]; empty?: string })
  | (Base & { kind: "text"; text: string })
  | (Base & {
      kind: "actions";
      actions: { id: string; label: string; variant: "default" | "secondary" | "destructive"; confirm?: string }[];
    });

interface TabView {
  plugin: string;
  displayName: string;
  tab: { id: string; label: string; icon?: string; description?: string };
  widgets: Widget[];
}

const DEFAULT_POLL_MS = 15000;

function MiniChart({ series, kind }: { series: number[]; kind: "line" | "bars" }) {
  if (series.length === 0) return null;
  const max = Math.max(...series);
  const min = Math.min(...series);
  const span = max - min || 1;
  const y = (v: number) => 30 - ((v - min) / span) * 26;
  if (kind === "bars") {
    const w = 100 / series.length;
    return (
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-24 w-full">
        {series.map((v, i) => {
          const h = Math.max(1.5, ((v - min) / span) * 28);
          return (
            <rect
              key={i}
              x={i * w + w * 0.15}
              y={30 - h}
              width={Math.max(0.5, w * 0.7)}
              height={h}
              rx={1}
              className="fill-[#a78bfa]"
              opacity={0.45 + (0.55 * i) / series.length}
            />
          );
        })}
      </svg>
    );
  }
  const pts = series.map((v, i) => `${(i / Math.max(1, series.length - 1)) * 100},${y(v)}`).join(" ");
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-24 w-full">
      <polyline points={pts} fill="none" stroke="#a78bfa" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {series.map((v, i) => (
        <circle
          key={i}
          cx={(i / Math.max(1, series.length - 1)) * 100}
          cy={y(v)}
          r={1.6}
          className="fill-[#a78bfa]"
        />
      ))}
    </svg>
  );
}

function WidgetError({ message }: { message: string }) {
  return <p className="mt-2 truncate text-xs font-bold text-[#ff7a78]" title={message}>{message}</p>;
}

function WidgetCard({ widget, children }: { widget: Base; children: React.ReactNode }) {
  return (
    <Card className={cn(widget.width === "full" && "md:col-span-2")}>
      {(widget.title || widget.error) && (
        <CardHeader className="pb-2">
          {widget.title && <CardTitle>{widget.title}</CardTitle>}
          {widget.error && <WidgetError message={widget.error} />}
        </CardHeader>
      )}
      <CardContent className={cn(!widget.title && !widget.error && "pt-5")}>{children}</CardContent>
    </Card>
  );
}

export default function PluginTab() {
  const { plugin, tab } = useParams<{ plugin: string; tab: string }>();
  const [view, setView] = useState<TabView | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!plugin || !tab) return;
    try {
      const d = await api<TabView>(`/api/ui/tab/${encodeURIComponent(plugin)}/${encodeURIComponent(tab)}`);
      setView(d);
      setErr("");
      return d;
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setView(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [plugin, tab]);

  // Carga inicial + polling según el menor refreshMs declarado (defecto 15s).
  useEffect(() => {
    setLoading(true);
    setView(null);
    setErr("");
    setNotice("");
    if (timer.current) clearInterval(timer.current);
    load().then((d) => {
      if (!d) return;
      const ms = d.widgets
        .map((w) => w.refreshMs)
        .filter((n): n is number => typeof n === "number" && n >= 5000);
      const poll = ms.length > 0 ? Math.min(...ms) : DEFAULT_POLL_MS;
      timer.current = setInterval(() => {
        load();
      }, poll);
    });
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  const runAction = async (actionId: string, label: string, confirm?: string) => {
    if (!plugin) return;
    if (confirm && !window.confirm(confirm)) return;
    setBusy(actionId);
    setNotice("");
    setErr("");
    try {
      const d = await api<{ ok: boolean; message: string | null }>(
        `/api/ui/${encodeURIComponent(plugin)}/action/${encodeURIComponent(actionId)}`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setNotice(d.message ?? `"${label}" hecho ✓`);
      await load();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Skeleton className="h-40 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      </div>
    );
  }

  if (err && !view) {
    return (
      <div className="space-y-4">
        <PageHeader title="Vista no disponible" description="Esa pestaña ya no existe (quizá el plugin se recargó)." />
        <EmptyState
          emoji="🧭"
          tone="gray"
          title="Nada por aquí"
          description="Vuelve a la lista de plugins o espera a que se recargue."
          action={
            <Link to="/plugins">
              <Button size="sm">Ver plugins</Button>
            </Link>
          }
        />
      </div>
    );
  }

  if (!view) return null;
  const Icon = uiIcon(view.tab.icon);

  return (
    <div className="space-y-5">
      <PageHeader
        title={view.tab.label}
        description={`${view.displayName}${view.tab.description ? ` · ${view.tab.description}` : ""}`}
        actions={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#2e2e2e] bg-[#1a1a1a] px-3 py-1.5 text-xs font-bold text-muted-foreground">
            <Icon className="size-3.5" />
            {view.displayName}
          </span>
        }
      />

      {err && <AlertError message={err} />}
      {notice && (
        <p className="rounded-xl border border-[#00d4aa33] bg-[#00d4aa11] px-4 py-2.5 text-sm font-bold text-[#00d4aa]">
          {notice}
        </p>
      )}

      {view.widgets.length === 0 ? (
        <EmptyState
          emoji="🧩"
          tone="violet"
          title="Tab vacío todavía"
          description="Este plugin aún no ha colocado widgets aquí."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {view.widgets.map((w) => {
            switch (w.kind) {
              case "stat": {
                const SIcon = uiIcon(w.icon);
                return (
                  <WidgetCard key={w.id} widget={w}>
                    <div className="flex items-center gap-3.5">
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-[#a78bfa33] bg-[#a78bfa11] text-[#a78bfa]">
                        <SIcon className="size-5" strokeWidth={2.5} />
                      </span>
                      <p className="tnum truncate font-display text-4xl font-semibold tracking-tight">
                        {w.value}
                        {w.suffix && <span className="ml-1 text-lg text-muted-foreground">{w.suffix}</span>}
                      </p>
                    </div>
                  </WidgetCard>
                );
              }
              case "table":
                return (
                  <WidgetCard key={w.id} widget={w}>
                    {w.rows.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{w.empty ?? "Sin filas todavía."}</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-[13px]">
                          <thead>
                            <tr className="border-b border-border text-xs font-bold text-muted-foreground">
                              {w.columns.map((c) => (
                                <th key={c.key} className="px-2 py-2 first:pl-0 last:pr-0">{c.label}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {w.rows.map((row, i) => (
                              <tr key={i} className="border-b border-border/50 last:border-0">
                                {row.map((cell, j) => (
                                  <td key={j} className={cn("max-w-[220px] truncate px-2 py-2 first:pl-0 last:pr-0", w.columns[j]?.mono && "font-mono text-xs")}>
                                    {cell}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </WidgetCard>
                );
              case "list":
                return (
                  <WidgetCard key={w.id} widget={w}>
                    {w.items.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{w.empty ?? "Vacío todavía."}</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {w.items.map((item, i) => (
                          <li key={i} className="rounded-lg bg-[#1a1a1a] px-3 py-2 text-[13px] font-semibold">{item}</li>
                        ))}
                      </ul>
                    )}
                  </WidgetCard>
                );
              case "line":
              case "bars":
                return (
                  <WidgetCard key={w.id} widget={w}>
                    {w.series.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{w.empty ?? "Sin datos todavía."}</p>
                    ) : (
                      <MiniChart series={w.series} kind={w.kind} />
                    )}
                  </WidgetCard>
                );
              case "text":
                return (
                  <WidgetCard key={w.id} widget={w}>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{w.text}</p>
                  </WidgetCard>
                );
              case "actions":
                return (
                  <WidgetCard key={w.id} widget={w}>
                    <div className="flex flex-wrap gap-2">
                      {w.actions.map((a) => (
                        <Button
                          key={a.id}
                          variant={a.variant === "default" ? "default" : a.variant}
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => runAction(a.id, a.label, a.confirm)}
                        >
                          {busy === a.id ? "Haciendo…" : a.label}
                        </Button>
                      ))}
                    </div>
                  </WidgetCard>
                );
            }
          })}
        </div>
      )}
    </div>
  );
}
