import { logger } from "./logger.js";

const WINDOW = 200;
const DEFAULT_SLOW_THRESHOLD_MS = 5000;

export interface MetricWindow {
  count: number;
  errors: number;
  avgMs: number;
  p95Ms: number;
  lastMs: number | null;
  lastOk: boolean | null;
  lastError?: string;
}

export interface PluginMetricsDTO {
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

type Op = "command" | "http" | "job";

interface Sample {
  ts: number;
  ms: number;
  ok: boolean;
  error?: string;
}

interface OpState {
  samples: Sample[];
  startupMs: number | null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function windowOf(samples: Sample[]): MetricWindow {
  const durs = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => !s.ok).length;
  const last = samples[samples.length - 1];
  return {
    count: samples.length,
    errors,
    avgMs: samples.length ? Math.round((samples.reduce((a, b) => a + b.ms, 0) / samples.length) * 10) / 10 : 0,
    p95Ms: percentile(durs, 95),
    lastMs: last ? last.ms : null,
    lastOk: last ? last.ok : null,
    lastError: last && !last.ok ? last.error : undefined,
  };
}

export class PluginMetrics {
  private states = new Map<string, OpState>();
  private slowThresholdMs = DEFAULT_SLOW_THRESHOLD_MS;
  /** Muestra de proceso: rss, heapUsed, cpu (delta) por plugin, última. */
  private processSnap = new Map<string, { rssMb: number; heapMb: number; cpuPercent: number; at: number }>();

  setSlowThresholdMs(ms: number): void {
    this.slowThresholdMs = ms;
  }

  private stateOf(name: string): OpState {
    let s = this.states.get(name);
    if (!s) {
      s = { samples: [], startupMs: null };
      this.states.set(name, s);
    }
    return s;
  }

  private push(name: string, op: Op, ms: number, ok: boolean, error?: string): void {
    const s = this.stateOf(name);
    const arr = (s as unknown as { command: Sample[]; http: Sample[]; job: Sample[] })[op];
    arr.push({ ts: Date.now(), ms, ok, error });
    if (arr.length > WINDOW) arr.shift();

    if (ms >= this.slowThresholdMs) {
      logger.warn(`plugin:${name}`, `operación lenta: ${op} ${ms}ms${error ? ` (${error})` : ""}`);
    }
  }

  startup(name: string, ms: number): void {
    const s = this.stateOf(name);
    s.startupMs = ms;
    if (ms >= this.slowThresholdMs) {
      logger.warn(`plugin:${name}`, `operación lenta: startup ${ms}ms`);
    }
  }

  command(name: string, ms: number, ok: boolean, error?: string): void {
    this.push(name, "command", ms, ok, error);
  }

  http(name: string, ms: number, ok: boolean, error?: string): void {
    this.push(name, "http", ms, ok, error);
  }

  job(name: string, ms: number, ok: boolean, error?: string): void {
    this.push(name, "job", ms, ok, error);
  }

  /** Muestra instantánea de memoria/CPU del proceso (asignada al plugin que la solicita). */
  sampleProcess(name: string): void {
    const usage = process.cpuUsage();
    const mem = process.memoryUsage();
    // cpuPercent aproximado: delta de user+system sobre intervalo (sin intervalo previo usamos raw).
    const cpuPercent = ((usage.user + usage.system) / 1e6 / (process.uptime() || 1)) * 100;
    this.processSnap.set(name, {
      rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
      heapMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      at: Date.now(),
    });
  }

  getSnapshot(name: string): PluginMetricsDTO | null {
    if (!this.states.has(name)) return null;
    const s = this.stateOf(name);
    const cmd = (s as unknown as { command: Sample[] }).command;
    const http = (s as unknown as { http: Sample[] }).http;
    const job = (s as unknown as { job: Sample[] }).job;
    const proc = this.processSnap.get(name) ?? { rssMb: 0, heapMb: 0, cpuPercent: 0, at: 0 };
    return {
      name,
      startupMs: s.startupMs,
      command: windowOf(cmd),
      http: windowOf(http),
      job: windowOf(job),
      rssMb: proc.rssMb,
      heapMb: proc.heapMb,
      cpuPercent: proc.cpuPercent,
      updatedAt: new Date(proc.at || Date.now()).toISOString(),
    };
  }

  getAllSnapshots(): PluginMetricsDTO[] {
    return [...this.states.keys()].map((n) => this.getSnapshot(n)).filter((s): s is PluginMetricsDTO => !!s);
  }
}

export const pluginMetrics = new PluginMetrics();
