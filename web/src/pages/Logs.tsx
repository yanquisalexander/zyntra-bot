import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Pause, Play, Search, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { timeOnly, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/common";

interface Entry {
  ts: string;
  level: string;
  source: string;
  message: string;
}

const levelLabel: Record<string, string> = {
  info: "info",
  warn: "aviso",
  error: "error",
  debug: "detalle",
};
const levelText = (l: string) => levelLabel[l] ?? l;

const levelFilterLabel: Record<string, string> = {
  all: "todos",
  info: "info",
  warn: "avisos",
  error: "errores",
  debug: "detalle",
};

const levelCls: Record<string, string> = {
  error: "text-[#ff7a78]",
  warn: "text-[#ffb700]",
  info: "text-zinc-200",
  debug: "text-zinc-500",
};

export default function Logs() {
  const [logs, setLogs] = useState<Entry[]>([]);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<string>("all");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    let alive = true;
    api<{ logs: Entry[] }>("/api/logs?limit=300")
      .then((d) => alive && setLogs(d.logs))
      .catch(() => undefined);
    const es = new EventSource("/api/logs/stream");
    es.onmessage = (m) => {
      if (pausedRef.current) return;
      try {
        const e = JSON.parse(m.data) as Entry;
        setLogs((prev) => [...prev.slice(-499), e]);
      } catch {
        /* noop */
      }
    };
    es.onerror = () => undefined;
    return () => {
      alive = false;
      es.close();
    };
  }, []);

  const sources = useMemo(() => {
    const s = new Set(logs.map((l) => l.source));
    return [...s].sort().slice(0, 12);
  }, [logs]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return logs
      .filter((l) => (level === "all" ? true : l.level === level))
      .filter((l) =>
        !q
          ? true
          : l.source.toLowerCase().includes(q) || l.message.toLowerCase().includes(q),
      )
      .slice(-200);
  }, [logs, filter, level]);

  useEffect(() => {
    if (autoScroll && !paused) bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [shown.length, autoScroll, paused]);

  const errCount = logs.filter((l) => l.level === "error").length;
  const warnCount = logs.filter((l) => l.level === "warn").length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Logs"
        description={`Lo que está haciendo el bot ahora mismo (${logs.length} visibles).`}
        actions={
          <>
            <Button variant={paused ? "default" : "outline"} size="sm" onClick={() => setPaused(!paused)}>
              {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
              {paused ? "Reanudar" : "Pausar"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setLogs([])}>
              <Trash2 className="size-4" />
              Limpiar
            </Button>
          </>
        }
      />

      {/* Filtros */}
      <Card>
        <CardContent className="flex flex-col gap-2.5 p-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Buscar por plugin o palabra…"
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Nivel de detalle">
            {(["all", "info", "warn", "error", "debug"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLevel(l)}
                aria-pressed={level === l}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-extrabold transition-colors",
                  level === l
                    ? "border-[#5865f233] bg-[#5865f211] text-[#8b93ff]"
                    : "border-[#2e2e2e] bg-[#1a1a1a] text-muted-foreground hover:text-foreground",
                )}
              >
                {levelFilterLabel[l] ?? l}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="destructive">{errCount} errores</Badge>
            <Badge variant="warning">{warnCount} avisos</Badge>
            <Switch
              checked={autoScroll}
              onChange={setAutoScroll}
              label={autoScroll ? "Siguiendo lo nuevo" : "Sin seguir"}
            />
          </div>
        </CardContent>
      </Card>

      {/* Fuentes rápidas */}
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sources.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={cn(
                "rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
                filter === s
                  ? "border-[#5865f233] bg-[#5865f211] text-[#8b93ff]"
                  : "border-[#2e2e2e] bg-[#1a1a1a] text-muted-foreground hover:text-foreground",
              )}
            >
              {s}
            </button>
          ))}
          {filter && (
            <button onClick={() => setFilter("")} className="px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
              ✕ quitar filtro
            </button>
          )}
        </div>
      )}

      {/* Lista */}
      <Card className="overflow-hidden">
        <div className="max-h-[62vh] space-y-1 overflow-y-auto p-2.5 font-mono text-xs leading-relaxed">
          {shown.length === 0 ? (
            <p className="px-3 py-10 text-center font-sans text-sm text-muted-foreground">
              {paused ? "En pausa." : "Silencio total… 🤫 Usa el bot en Discord y verás qué pasa aquí."}
            </p>
          ) : (
            shown.map((l, i) => (
              <div
                key={`${l.ts}-${i}`}
                className="flex flex-wrap items-baseline gap-x-2 rounded-lg bg-[#1a1a1a] px-3 py-1.5 transition-colors hover:bg-[#202020]"
              >
                <span className="shrink-0 text-zinc-600">{timeOnly(l.ts)}</span>
                <span className={cn("w-14 shrink-0 font-semibold", levelCls[l.level] ?? "text-zinc-300")}>
                  {levelText(l.level)}
                </span>
                <span className="shrink-0 text-[#a78bfa]">{l.source}</span>
                <span className="min-w-0 flex-1 break-words text-zinc-300">{l.message.slice(0, 600)}</span>
                {l.source.startsWith("plugin:") && (
                  <Link
                    className="shrink-0 font-sans text-[11px] font-bold text-[#8b93ff] hover:underline"
                    to={`/plugins/${encodeURIComponent(l.source.slice(7))}`}
                  >
                    abrir editor
                  </Link>
                )}
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </Card>
    </div>
  );
}
