import { CronExpressionParser } from "cron-parser";
import { v7 as uuidv7 } from "uuid";
import { logger } from "./logger.js";
import { runWithPlugin } from "./consoleBridge.js";

/**
 * Mini-sidekiq in-process: tareas recurrentes (intervalo/cron) y one-shots
 * con IDs estables, timeout por ejecución, anti-solape (salta y avisa) e
 * historial. La memoria manda; Postgres espeja best-effort (puede no existir).
 *
 * - Recurrentes se re-registran desde el código en cada carga.
 * - One-shots pendientes sobreviven reinicios: al re-registrarse con el mismo
 *   ID se adopta el `runAt` guardado (con el código fresco).
 * - Pausar/reenudar persiste (override en DB).
 */

export type JobKind = "interval" | "cron" | "once";
export type JobState = "scheduled" | "paused" | "running" | "invalid" | "done" | "cancelled";

export const DEFAULT_JOB_TIMEOUT_MS = 30_000;
const RUN_HISTORY = 200;
const MAX_TIMER = 2 ** 31 - 1;
const REARM_CHUNK = 7 * 24 * 3600 * 1000;

interface InternalSchedule {
  id: string;
  plugin: string;
  name: string;
  kind: JobKind;
  expr: string;
  intervalMs?: number;
  cron?: string;
  description?: string;
  timeoutMs: number;
  fn: () => unknown;
  onTimer?: (t: NodeJS.Timeout) => void;
  paused: boolean;
  invalidReason?: string;
  terminal?: "done" | "cancelled";
  running: boolean;
  timer: NodeJS.Timeout | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastOk: boolean | null;
  lastError?: string;
  lastDurationMs: number | null;
  runs: number;
  skips: number;
}

export interface JobRun {
  id: string;
  scheduleId: string;
  plugin: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  ok: boolean | null;
  error?: string;
}

export interface JobScheduleDTO {
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

export interface OrphanJobDTO {
  id: string;
  plugin: string;
  name: string;
  expr: string;
  runAt: string;
  overdue: boolean;
}

/**
 * Foto de los horarios pendientes de un plugin, para conservar el tiempo
 * restante a través de un reload (misma cadencia → mismo horario).
 */
export interface JobSnapshot {
  id: string;
  kind: JobKind;
  intervalMs?: number;
  cron?: string;
  expr: string;
  nextRunAt: number | null;
  runs: number;
  skips: number;
  lastRunAt: number | null;
  lastOk: boolean | null;
  lastError?: string;
  lastDurationMs: number | null;
}

export function humanizeInterval(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `cada ${s} s`;
  const m = ms / 60000;
  if (m < 60) return `cada ${trimNum(m)} min`;
  const h = ms / 3600000;
  if (h < 48) return `cada ${trimNum(h)} h`;
  return `cada ${trimNum(ms / 86400000)} d`;
}

function trimNum(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function nextCronRun(cron: string, from = Date.now()): number {
  return CronExpressionParser.parse(cron).next().toDate().getTime();
}

export function isValidCron(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

export class JobScheduler {
  private schedules = new Map<string, InternalSchedule>();
  private runs: JobRun[] = [];
  /** Pausas persistidas (hidratadas antes del autoload). */
  private pausedIds = new Set<string>();
  /** One-shots pendientes en DB esperando a que su plugin los adopte. */
  private pendingAdoption = new Map<string, { plugin: string; name: string; expr: string; runAt: number; description?: string; timeoutMs: number }>();
  /** IDs con una ejecución en curso (no se puede conservar su horario). */
  private inFlight = new Set<string>();

  /** Lee pausas + one-shots pendientes + purga historial. Llamar antes del autoload. */
  async hydrate(): Promise<void> {
    try {
      const { getDb } = await import("../db/client.js");
      const { jobSchedules, jobRuns } = await import("../db/schema.js");
      const { lt } = await import("drizzle-orm");
      const db = getDb();
      const rows = (await db.select().from(jobSchedules)) as Record<string, unknown>[];
      for (const r of rows) {
        const id = r["id"] as string;
        if (r["paused"]) this.pausedIds.add(id);
        if (r["kind"] === "once" && r["status"] === "pending" && r["next_run_at"]) {
          this.pendingAdoption.set(id, {
            plugin: r["plugin_name"] as string,
            name: r["name"] as string,
            expr: (r["expr"] as string) ?? "",
            runAt: new Date(r["next_run_at"] as string).getTime(),
            description: (r["description"] as string | null) ?? undefined,
            timeoutMs: (r["timeout_ms"] as number) ?? DEFAULT_JOB_TIMEOUT_MS,
          });
        }
      }
      await db
        .delete(jobRuns)
        .where(lt(jobRuns.startedAt, new Date(Date.now() - 7 * 24 * 3600 * 1000) as never));
    } catch {
      /* DB opcional: sin pausas ni huérfanas */
    }
  }

  register(input: {
    plugin: string;
    name: string;
    kind: JobKind;
    expr: string;
    intervalMs?: number;
    cron?: string;
    runAt?: number;
    description?: string;
    timeoutMs?: number;
    fn: () => unknown;
    onTimer?: (t: NodeJS.Timeout) => void;
  }): JobScheduleDTO {
    const id = `${input.plugin}:${input.name}`;
    const prev = this.schedules.get(id);
    if (prev?.timer) clearTimeout(prev.timer);
    if (prev) logger.warn(`plugin:${input.plugin}`, `tarea !${input.name} sobrescrita (evita duplicados)`);

    const s: InternalSchedule = {
      id,
      plugin: input.plugin,
      name: input.name,
      kind: input.kind,
      expr: input.expr,
      intervalMs: input.intervalMs,
      cron: input.cron,
      description: input.description,
      timeoutMs: input.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
      fn: input.fn,
      onTimer: input.onTimer,
      paused: this.pausedIds.has(id),
      running: false,
      timer: null,
      nextRunAt: null,
      lastRunAt: null,
      lastOk: null,
      lastDurationMs: null,
      runs: 0,
      skips: 0,
    };

    // Valida la expresión sin lanzar: lo inválido se marca y se loguea.
    if (input.kind === "cron" && (!input.cron || !isValidCron(input.cron))) {
      s.invalidReason = `cron inválido: ${input.cron ?? "vacío"}`;
    } else if (input.kind === "interval" && (!input.intervalMs || !(input.intervalMs > 0))) {
      s.invalidReason = `intervalo inválido: ${input.expr}`;
    } else if (input.kind === "once" && (!input.runAt || !Number.isFinite(input.runAt))) {
      s.invalidReason = `fecha inválida: ${input.expr}`;
    }
    if (s.invalidReason) {
      logger.error(`plugin:${input.plugin}`, `tarea ${input.name}: ${s.invalidReason} (marcada inválida)`);
      this.schedules.set(id, s);
      void this.persist(s, "invalid");
      return this.dto(s);
    }

    if (input.kind === "once") {
      // Adopta el pendiente guardado (mismo ID): manda su runAt original.
      let runAt = input.runAt as number;
      const orphan = this.pendingAdoption.get(id);
      if (orphan) {
        this.pendingAdoption.delete(id);
        runAt = orphan.runAt;
        if (runAt <= Date.now()) {
          logger.warn(`plugin:${input.plugin}`, `tarea ${input.name}: venció con el servidor caído, corre ahora`);
          runAt = Date.now() + 1000;
        } else {
          logger.info(`plugin:${input.plugin}`, `tarea ${input.name}: adoptada, prevista para ${new Date(runAt).toLocaleString("es-ES")}`);
        }
      }
      s.nextRunAt = runAt;
    }

    if (s.paused) logger.info(`plugin:${input.plugin}`, `tarea ${input.name}: arranca en pausa (override)`);
    this.schedules.set(id, s);
    this.arm(s);
    void this.persist(s, "pending");
    return this.dto(s);
  }

  cancel(id: string): boolean {
    const s = this.schedules.get(id);
    if (!s || s.kind !== "once") return false;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.nextRunAt = null;
    s.terminal = "cancelled";
    logger.info(`plugin:${s.plugin}`, `tarea ${s.name}: one-shot cancelado`);
    void this.persist(s, "cancelled");
    this.schedules.delete(id);
    return true;
  }

  pause(id: string): boolean {
    const s = this.schedules.get(id);
    if (!s || s.terminal || s.invalidReason) return false;
    this.pausedIds.add(id);
    s.paused = true;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.nextRunAt = null;
    logger.info(`plugin:${s.plugin}`, `tarea ${s.name}: en pausa`);
    void this.persist(s, "paused");
    return true;
  }

  resume(id: string): boolean {
    const s = this.schedules.get(id);
    if (!s || s.terminal || s.invalidReason || !s.paused) return false;
    this.pausedIds.delete(id);
    s.paused = false;
    logger.info(`plugin:${s.plugin}`, `tarea ${s.name}: reanudada`);
    this.arm(s);
    void this.persist(s, "pending");
    return true;
  }

  /** Dispara ahora (en background). Devuelve el ID del run. Falla si está en curso. */
  runNow(id: string): string {
    const s = this.schedules.get(id);
    if (!s) throw new Error("tarea no encontrada");
    if (s.invalidReason) throw new Error(`tarea inválida: ${s.invalidReason}`);
    if (s.terminal) throw new Error("tarea terminada");
    if (s.running) throw new Error("ya hay una ejecución en curso");
    if (s.paused) throw new Error("tarea en pausa (reanúdala primero)");
    logger.info(`plugin:${s.plugin}`, `tarea ${s.name}: ejecución manual`);
    if (s.kind === "once" && s.timer) {
      // El disparo manual consume el pendiente (no corre dos veces).
      clearTimeout(s.timer);
      s.timer = null;
    }
    void this.execute(s);
    // El run se crea dentro de execute(); devolvemos el último.
    const last = this.runs.find((r) => r.scheduleId === id);
    return last?.id ?? "";
  }

  /** Cancela una huérfana (solo existe en DB). */
  async cancelOrphan(id: string): Promise<boolean> {
    try {
      const { getDb } = await import("../db/client.js");
      const { jobSchedules } = await import("../db/schema.js");
      const { eq, and } = await import("drizzle-orm");
      const db = getDb();
      const rows = await db
        .update(jobSchedules)
        .set({ status: "cancelled", nextRunAt: null, updatedAt: new Date() } as never)
        .where(
          and(
            eq(jobSchedules.id, id),
            eq(jobSchedules.kind, "once"),
            eq(jobSchedules.status, "pending"),
          ),
        )
        .returning({ id: jobSchedules.id });
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  /** Baja un plugin: cancela timers y olvida schedules (el historial queda). */
  removePlugin(plugin: string): void {
    for (const [id, s] of this.schedules) {
      if (s.plugin !== plugin) continue;
      if (s.timer) clearTimeout(s.timer);
      this.schedules.delete(id);
    }
  }

  /**
   * Foto de horarios pendientes (con timer futuro) de un plugin.
   * Pausadas, terminales e inválidas no tienen timer → se excluyen solas.
   */
  snapshot(plugin: string): JobSnapshot[] {
    const out: JobSnapshot[] = [];
    for (const s of this.schedules.values()) {
      if (s.plugin !== plugin) continue;
      if (s.terminal || s.invalidReason) continue;
      if (s.nextRunAt == null) continue;
      out.push({
        id: s.id,
        kind: s.kind,
        intervalMs: s.intervalMs,
        cron: s.cron,
        expr: s.expr,
        nextRunAt: s.nextRunAt,
        runs: s.runs,
        skips: s.skips,
        lastRunAt: s.lastRunAt,
        lastOk: s.lastOk,
        lastError: s.lastError,
        lastDurationMs: s.lastDurationMs,
      });
    }
    return out;
  }

  /**
   * Tras un reload con la misma cadencia, conserva tiempo restante y
   * estadísticas en vez de rearmar desde cero. Si la cadencia cambió, la
   * ejecución anterior sigue en curso, o el horario ya pasó: arranque fresco.
   */
  restore(plugin: string, snap: JobSnapshot[]): void {
    for (const s of this.schedules.values()) {
      if (s.plugin !== plugin || s.invalidReason || s.terminal) continue;
      const prev = snap.find((x) => x.id === s.id);
      if (!prev) continue;
      const sameCadence =
        prev.kind === s.kind &&
        (s.kind !== "interval" || prev.intervalMs === s.intervalMs) &&
        (s.kind !== "cron" || prev.cron === s.cron) &&
        (s.kind !== "once" || prev.expr === s.expr);
      if (!sameCadence) continue;
      if (this.inFlight.has(s.id)) continue;
      // Estadísticas: la tarea continúa donde iba.
      s.runs = prev.runs;
      s.skips = prev.skips;
      s.lastRunAt = prev.lastRunAt;
      s.lastOk = prev.lastOk;
      s.lastError = prev.lastError;
      s.lastDurationMs = prev.lastDurationMs;
      // Horario: conserva el tiempo restante si sigue en futuro.
      if (prev.nextRunAt != null && prev.nextRunAt > Date.now()) {
        if (s.timer) clearTimeout(s.timer);
        this.armAt(s, prev.nextRunAt);
        logger.info(
          `plugin:${s.plugin}`,
          `tarea ${s.name}: conserva horario (${Math.round((prev.nextRunAt - Date.now()) / 1000)}s restantes)`,
        );
      }
    }
  }

  list(): JobScheduleDTO[] {
    return [...this.schedules.values()]
      .map((s) => this.dto(s))
      .sort((a, b) => a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name));
  }

  recentRuns(limit = 100): JobRun[] {
    return this.runs.slice(0, Math.min(limit, RUN_HISTORY));
  }

  async orphans(): Promise<OrphanJobDTO[]> {
    try {
      const { getDb } = await import("../db/client.js");
      const { jobSchedules } = await import("../db/schema.js");
      const { eq, and } = await import("drizzle-orm");
      const db = getDb();
      const rows = (await db
        .select()
        .from(jobSchedules)
        .where(and(eq(jobSchedules.kind, "once"), eq(jobSchedules.status, "pending")))) as Record<string, unknown>[];
      const now = Date.now();
      return rows
        .filter((r) => !this.schedules.has(r["id"] as string))
        .map((r) => {
          const runAt = new Date(r["next_run_at"] as string).getTime();
          return {
            id: r["id"] as string,
            plugin: r["plugin_name"] as string,
            name: r["name"] as string,
            expr: (r["expr"] as string) ?? "",
            runAt: new Date(runAt).toISOString(),
            overdue: runAt <= now,
          };
        });
    } catch {
      return [];
    }
  }

  // ---- interno ----

  private dto(s: InternalSchedule): JobScheduleDTO {
    const status: JobState = s.invalidReason
      ? "invalid"
      : s.terminal ?? (s.paused ? "paused" : s.running ? "running" : "scheduled");
    const exprHuman =
      s.kind === "interval"
        ? humanizeInterval(s.intervalMs ?? 0)
        : s.kind === "cron"
          ? s.cron ?? s.expr
          : `una vez: ${s.nextRunAt ? new Date(s.nextRunAt).toLocaleString("es-ES") : s.expr}`;
    return {
      id: s.id,
      plugin: s.plugin,
      name: s.name,
      kind: s.kind,
      expr: s.expr,
      exprHuman,
      description: s.description,
      timeoutMs: s.timeoutMs,
      paused: s.paused,
      status,
      invalidReason: s.invalidReason,
      running: s.running,
      nextRunAt: s.nextRunAt ? new Date(s.nextRunAt).toISOString() : null,
      lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null,
      lastOk: s.lastOk,
      lastError: s.lastError,
      lastDurationMs: s.lastDurationMs,
      runs: s.runs,
      skips: s.skips,
    };
  }

  private computeNext(s: InternalSchedule): number | null {
    if (s.paused || s.invalidReason || s.terminal) return null;
    try {
      if (s.kind === "interval") return Date.now() + (s.intervalMs as number);
      if (s.kind === "cron") return nextCronRun(s.cron as string);
      return s.nextRunAt;
    } catch (e) {
      s.invalidReason = `cron inválido: ${String(e instanceof Error ? e.message.split("\n")[0] : e)}`;
      logger.error(`plugin:${s.plugin}`, `tarea ${s.name}: ${s.invalidReason}`);
      return null;
    }
  }

  private arm(s: InternalSchedule): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    const next = this.computeNext(s);
    s.nextRunAt = next;
    if (next === null) {
      void this.persist(s, s.invalidReason ? "invalid" : s.terminal ?? (s.paused ? "paused" : "pending"));
      return;
    }
    let at = next;
    if (s.kind !== "once" && at - Date.now() < 0) {
      // Recurrente atrasada (pausa larga): reprograma desde ahora, sin cascada.
      at = s.kind === "interval" ? Date.now() + (s.intervalMs as number) : nextCronRun(s.cron as string);
    }
    this.armAt(s, at);
  }

  /** Arma el timer para un instante absoluto (usado también por restore). */
  private armAt(s: InternalSchedule, at: number): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.nextRunAt = at;
    let delay = at - Date.now();
    if (delay < 0) delay = 0;
    const chunked = at - Date.now() > MAX_TIMER;
    if (delay > MAX_TIMER) delay = REARM_CHUNK;
    const t = setTimeout(() => {
      if (chunked) {
        this.arm(s);
        return;
      }
      this.onTick(s);
    }, delay);
    if (typeof (t as unknown as { unref?: unknown }).unref === "function") {
      (t as unknown as { unref(): void }).unref();
    }
    s.timer = t;
    s.onTimer?.(t);
    void this.persist(s, "pending");
  }

  /**
   * Tick de fixed-rate: si sigue en curso se salta (y se avisa); si no,
   * se programa lo siguiente ANTES de ejecutar, para que el solape exista.
   */
  private onTick(s: InternalSchedule): void {
    s.timer = null;
    if (s.running) {
      s.skips += 1;
      logger.warn(`plugin:${s.plugin}`, `tarea ${s.name}: salto (sigue en curso)`);
      if (s.kind !== "once") this.arm(s);
      void this.persist(s, "pending");
      return;
    }
    if (s.kind !== "once") this.arm(s);
    void this.execute(s);
  }

  private async execute(s: InternalSchedule): Promise<void> {
    s.running = true;
    this.inFlight.add(s.id);
    const run: JobRun = {
      id: uuidv7(),
      scheduleId: s.id,
      plugin: s.plugin,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      ok: null,
    };
    this.runs.unshift(run);
    if (this.runs.length > RUN_HISTORY) this.runs.length = RUN_HISTORY;
    const t0 = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeoutP = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`timeout (${s.timeoutMs}ms)`)), s.timeoutMs);
    });
    try {
      await Promise.race([s.fn(), timeoutP]);
      run.ok = true;
    } catch (e) {
      run.ok = false;
      run.error = String(e instanceof Error ? e.message : e).slice(0, 500);
      logger.error(`plugin:${s.plugin}`, `tarea ${s.name} falló: ${run.error}`);
    } finally {
      if (timer) clearTimeout(timer);
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.now() - t0;
      s.running = false;
      this.inFlight.delete(s.id);
      s.lastRunAt = t0;
      s.lastOk = run.ok;
      s.lastError = run.error;
      s.lastDurationMs = run.durationMs;
      s.runs += 1;
      if (s.kind === "once") {
        s.terminal = "done";
        s.nextRunAt = null;
        void this.persist(s, "done");
      }
      // Recurrentes: ya pre-armadas en onTick (no re-armar aquí o se
      // resucitaría una pausa pedida durante la ejecución).
      void this.persistRun(run);
    }
  }

  private async persist(s: InternalSchedule, status: string): Promise<void> {
    try {
      const { getDb } = await import("../db/client.js");
      const { jobSchedules } = await import("../db/schema.js");
      const { eq } = await import("drizzle-orm");
      const db = getDb();
      const row = {
        id: s.id,
        pluginName: s.plugin,
        name: s.name,
        kind: s.kind,
        expr: s.expr,
        description: s.description ?? null,
        timeoutMs: s.timeoutMs,
        paused: s.paused,
        status,
        runs: s.runs,
        skips: s.skips,
        lastOk: s.lastOk,
        lastError: s.lastError ?? null,
        lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
        nextRunAt: s.nextRunAt ? new Date(s.nextRunAt) : null,
        updatedAt: new Date(),
      };
      const ex = await db.select({ id: jobSchedules.id }).from(jobSchedules).where(eq(jobSchedules.id, s.id)).limit(1);
      if (ex.length === 0) await db.insert(jobSchedules).values(row as never);
      else await db.update(jobSchedules).set(row as never).where(eq(jobSchedules.id, s.id));
    } catch {
      /* DB opcional */
    }
  }

  private async persistRun(run: JobRun): Promise<void> {
    try {
      const { getDb } = await import("../db/client.js");
      const { jobRuns } = await import("../db/schema.js");
      const db = getDb();
      await db.insert(jobRuns).values({
        id: run.id,
        scheduleId: run.scheduleId,
        pluginName: run.plugin,
        ok: run.ok,
        durationMs: run.durationMs,
        error: run.error ?? null,
        startedAt: new Date(run.startedAt),
        finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
      } as never);
    } catch {
      /* DB opcional */
    }
  }
}
