import { useEffect, useState } from "react";
import { CalendarClock, History, Pause, Play, RefreshCw, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatDistanceEs, formatDurationMs } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeader,
  AlertError,
  EmptyState,
  IconBox,
  type Tone,
} from "@/components/common";

type JobKind = "interval" | "cron" | "once";
type JobState = "scheduled" | "paused" | "running" | "invalid" | "done" | "cancelled";

interface JobSchedule {
  id: string;
  plugin: string;
  name: string;
  kind: JobKind;
  expr: string;
  exprHuman: string;
  description?: string;
  timeoutMs: number;
  paused: boolean;
  status: JobState;
  invalidReason?: string;
  running: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastError?: string;
  lastDurationMs: number | null;
  runs: number;
  skips: number;
}

interface OrphanJob {
  id: string;
  plugin: string;
  name: string;
  expr: string;
  runAt: string;
  overdue: boolean;
}

interface JobRun {
  id: string;
  scheduleId: string;
  plugin: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  ok: boolean | null;
  error?: string;
}

const kindLabel: Record<JobKind, string> = {
  interval: "intervalo",
  cron: "cron",
  once: "una vez",
};

function JobBadge({ status }: { status: JobState }) {
  const map: Record<JobState, { variant: "success" | "destructive" | "warning" | "secondary" | "default"; dot: string; label: string }> = {
    scheduled: { variant: "success", dot: "bg-[#00d4aa]", label: "programada" },
    running: { variant: "default", dot: "bg-[#8b93ff] animate-pulse", label: "corriendo" },
    paused: { variant: "secondary", dot: "bg-zinc-500", label: "en pausa" },
    invalid: { variant: "destructive", dot: "bg-[#ff5e5b]", label: "inválida" },
    done: { variant: "secondary", dot: "bg-zinc-500", label: "hecha" },
    cancelled: { variant: "secondary", dot: "bg-zinc-500", label: "cancelada" },
  };
  const s = map[status];
  return (
    <Badge variant={s.variant}>
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </Badge>
  );
}

function RunBadge({ ok }: { ok: boolean | null }) {
  if (ok === null) {
    return (
      <Badge variant="default">
        <span className="size-1.5 rounded-full bg-[#8b93ff] animate-pulse" />
        en curso
      </Badge>
    );
  }
  return ok ? <Badge variant="success">bien</Badge> : <Badge variant="destructive">falló</Badge>;
}

export default function Jobs() {
  const [schedules, setSchedules] = useState<JobSchedule[]>([]);
  const [orphans, setOrphans] = useState<OrphanJob[]>([]);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const d = await api<{ schedules: JobSchedule[]; orphans: OrphanJob[]; runs: JobRun[] }>("/api/jobs");
      setSchedules(d.schedules);
      setOrphans(d.orphans);
      setRuns(d.runs);
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

  const act = async (id: string, action: "run" | "pause" | "resume" | "cancel") => {
    setBusy(`${action}-${id}`);
    setErr("");
    try {
      await api(`/api/jobs/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      await refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  const scheduled = schedules.filter((s) => s.status === "scheduled").length;
  const paused = schedules.filter((s) => s.status === "paused").length;
  const failed = schedules.filter((s) => s.status === "invalid").length + runs.filter((r) => r.ok === false).length;
  const empty = !loading && schedules.length === 0 && orphans.length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tareas"
        description="Trabajos programados de tus plugins: intervalos, cron y avisos de una vez."
        actions={
          <Button variant="secondary" onClick={refresh}>
            <RefreshCw className="size-4" />
            Actualizar
          </Button>
        }
      />

      {err && <AlertError message={err} />}

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MiniStat tone="mint" label="Programadas" value={loading ? "…" : String(scheduled)} />
        <MiniStat tone="gray" label="En pausa" value={loading ? "…" : String(paused)} />
        <MiniStat tone={failed > 0 ? "red" : "gray"} label="Fallos" value={loading ? "…" : String(failed)} />
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Skeleton className="h-44 w-full rounded-2xl" />
          <Skeleton className="h-44 w-full rounded-2xl" />
        </div>
      ) : empty ? (
        <EmptyState
          emoji="⏰"
          tone="violet"
          title="Sin tareas todavía"
          description="Registra la primera con api.jobs.every(...) en tu plugin y aparecerá aquí solita. 🚀"
        />
      ) : (
        <>
          {/* Programadas */}
          {schedules.length > 0 && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {schedules.map((s) => (
                <ScheduleCard key={s.id} s={s} busy={busy} onAct={act} />
              ))}
            </div>
          )}

          {/* Huérfanas */}
          {orphans.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Huérfanas 👻</CardTitle>
                <CardDescription>
                  Avisos guardados cuyo plugin no está cargado. Se aplicarán solos cuando vuelva, o bórralos aquí.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {orphans.map((o) => (
                  <div
                    key={o.id}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-[#1a1a1a] p-4"
                  >
                    <IconBox tone="yellow">👻</IconBox>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-extrabold">{o.name}</p>
                      <p className="truncate font-mono text-[11px] text-zinc-500">{o.id}</p>
                      <p className="text-xs font-bold text-muted-foreground">
                        prevista {formatDistanceEs(o.runAt)}
                        {o.overdue && <span className="ml-1 text-[#ffb700]">(atrasada)</span>}
                      </p>
                    </div>
                    <Button
                      variant="destructive"
                      size="xs"
                      disabled={busy !== null}
                      onClick={() => act(o.id, "cancel")}
                    >
                      <X className="size-3.5" />
                      Borrar
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Historial */}
          {runs.length > 0 && (
            <Card className="overflow-hidden">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <IconBox tone="gray">
                    <History className="size-5" strokeWidth={2.5} />
                  </IconBox>
                  <div>
                    <CardTitle>Últimas ejecuciones</CardTitle>
                    <CardDescription>Lo último que han hecho tus tareas</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {runs.slice(0, 20).map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[#1a1a1a] px-3.5 py-2.5"
                  >
                    <span className="font-mono text-[11px] text-zinc-500">{r.id.slice(0, 8)}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-extrabold">
                      {r.scheduleId}
                      {r.error && <span className="ml-2 truncate font-mono text-[11px] font-normal text-[#ff7a78]">{r.error.slice(0, 100)}</span>}
                    </span>
                    <span className="text-[11px] font-bold text-muted-foreground">
                      {formatDistanceEs(r.startedAt)} · {formatDurationMs(r.durationMs)}
                    </span>
                    <RunBadge ok={r.ok} />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function MiniStat({ tone, label, value }: { tone: Tone; label: string; value: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[13px] font-extrabold text-muted-foreground">{label}</p>
          <p className="tnum mt-1 font-display text-4xl font-semibold tracking-tight">{value}</p>
        </div>
        <IconBox tone={tone}>
          <CalendarClock className="size-5" strokeWidth={2.5} />
        </IconBox>
      </div>
    </Card>
  );
}

function ScheduleCard({
  s,
  busy,
  onAct,
}: {
  s: JobSchedule;
  busy: string | null;
  onAct: (id: string, action: "run" | "pause" | "resume" | "cancel") => void;
}) {
  const tone: Tone =
    s.status === "scheduled" || s.status === "running"
      ? s.kind === "once"
        ? "yellow"
        : "mint"
      : s.status === "invalid"
        ? "red"
        : "gray";
  const canRun = s.status === "scheduled" && !s.running;
  const canPause = (s.status === "scheduled" || s.status === "running") && !s.paused;
  const canCancel = s.kind === "once" && s.status === "scheduled";
  const overdue = s.nextRunAt !== null && new Date(s.nextRunAt).getTime() < Date.now() && s.status === "scheduled";

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <IconBox tone={tone}>
          <CalendarClock className="size-5" strokeWidth={2.5} />
        </IconBox>
        <JobBadge status={s.status} />
      </div>
      <p className="truncate font-display text-xl font-semibold tracking-tight">{s.name}</p>
      <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">{s.id}</p>
      {s.description && (
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{s.description}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge variant="outline">{kindLabel[s.kind]}</Badge>
        <Badge variant="secondary" className="font-mono font-normal">{s.exprHuman}</Badge>
        {s.skips > 0 && <Badge variant="warning">{s.skips} saltos</Badge>}
      </div>
      <div className="mt-3 space-y-1 text-xs font-bold text-muted-foreground">
        <p>
          Próxima:{" "}
          <span className="text-foreground">
            {s.nextRunAt ? formatDistanceEs(s.nextRunAt) : s.status === "paused" ? "en pausa" : "—"}
          </span>
          {overdue && <span className="ml-1 text-[#ffb700]">(atrasada)</span>}
        </p>
        <p>
          Última:{" "}
          <span className="text-foreground">
            {s.lastRunAt ? `${formatDistanceEs(s.lastRunAt)}${s.lastOk === false ? " · falló" : ""}` : "nunca"}
            {s.lastDurationMs !== null && s.lastRunAt ? ` · ${formatDurationMs(s.lastDurationMs)}` : ""}
          </span>
        </p>
        {s.invalidReason && <p className="text-[#ff7a78]">{s.invalidReason}</p>}
        {s.lastError && s.lastOk === false && <p className="truncate font-mono font-normal text-[#ff7a78]">{s.lastError.slice(0, 120)}</p>}
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        <Button variant="secondary" size="xs" disabled={busy !== null || !canRun} onClick={() => onAct(s.id, "run")}>
          <Play className="size-3.5" />
          Ahora
        </Button>
        {s.paused ? (
          <Button variant="outline" size="xs" disabled={busy !== null} onClick={() => onAct(s.id, "resume")}>
            <Play className="size-3.5" />
            Reanudar
          </Button>
        ) : (
          <Button variant="outline" size="xs" disabled={busy !== null || !canPause} onClick={() => onAct(s.id, "pause")}>
            <Pause className="size-3.5" />
            Pausar
          </Button>
        )}
        {canCancel && (
          <Button variant="destructive" size="xs" disabled={busy !== null} onClick={() => onAct(s.id, "cancel")}>
            <X className="size-3.5" />
            Cancelar
          </Button>
        )}
      </div>
    </Card>
  );
}
