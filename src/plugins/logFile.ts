import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.js";

const LOG_DIR = path.resolve(process.cwd(), "logs");
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB por archivo diario
const MAX_AGE_DAYS = 7;
const MAX_ROTATED_FILES = 30;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  meta?: unknown;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dayPath(ts: string): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  return path.join(LOG_DIR, String(y), m, `${day}.log`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatLine(entry: LogEntry): string {
  const meta = entry.meta != null ? ` ${JSON.stringify(entry.meta)}` : "";
  const msg = entry.message.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return `[${entry.ts}] [${entry.level.toUpperCase().padEnd(5)}] [${entry.source}] ${msg}${meta}`;
}

export class LogFileTransport {
  private currentDay: string | null = null;
  private currentPath: string | null = null;
  private currentSize = 0;
  private currentRot = 0;
  private queue: Array<() => Promise<void>> = [];
  private writing = false;
  private cleanupTimer: NodeJS.Timeout | null = null;

  async init(): Promise<void> {
    try {
      await fs.mkdir(LOG_DIR, { recursive: true });
    } catch {
      /* noop */
    }
    await this.rotateToDay(nowIso());
    this.scheduleCleanup();
    void this.cleanup().catch(() => undefined);
  }

  private scheduleCleanup(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = setInterval(() => {
      void this.cleanup().catch(() => undefined);
    }, CLEANUP_INTERVAL_MS);
    if (typeof this.cleanupTimer?.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  /** Ruta del archivo para un día dado. */
  private dayFilePath(ts: string): string {
    return dayPath(ts);
  }

  /** Rota al archivo del día dado (abre/crea si es necesario). */
  private async rotateToDay(ts: string): Promise<void> {
    const target = this.dayFilePath(ts);
    if (target === this.currentPath) return;

    // Cerrar archivo anterior (no hay handle persistente, solo estado).
    this.currentPath = target;
    this.currentDay = ts.slice(0, 10);
    this.currentSize = await this.fileSize(target);
    this.currentRot = await this.nextRotationIndex(target);
  }

  private async fileSize(file: string): Promise<number> {
    try {
      const st = await fs.stat(file);
      return st.size;
    } catch {
      return 0;
    }
  }

  /** Devuelve el siguiente índice de rotación para el archivo base (ej. .1, .2). */
  private async nextRotationIndex(base: string): Promise<number> {
    let max = 0;
    try {
      const dir = path.dirname(base);
      const entries = await fs.readdir(dir);
      const prefix = path.basename(base) + ".";
      for (const e of entries) {
        if (e.startsWith(prefix)) {
          const n = Number(e.slice(prefix.length));
          if (Number.isFinite(n) && n > max) max = n;
        }
      }
    } catch {
      /* noop */
    }
    return max;
  }

  /** Ruta de rotación para el día actual (base + .N). */
  private rotationPath(): string {
    const base = this.currentPath ?? "";
    if (this.currentRot === 0) return base;
    return `${base}.${this.currentRot}`;
  }

  private async ensureDay(ts: string): Promise<void> {
    const day = ts.slice(0, 10);
    if (day !== this.currentDay) {
      await this.rotateToDay(ts);
    }
  }

  /** Escribe una entrada al archivo de log (no bloqueante: encola). */
  write(entry: LogEntry): void {
    const line = formatLine(entry) + "\n";
    const task = async () => {
      await this.ensureDay(entry.ts);
      const target = this.rotationPath();
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.appendFile(target, line, "utf8");
        this.currentSize += Buffer.byteLength(line, "utf8");

        // Rotación por tamaño: si supera el tope, pasa al siguiente archivo .N+1
        if (this.currentSize >= MAX_FILE_BYTES) {
          this.currentRot += 1;
          this.currentSize = 0;
        }
      } catch {
        /* errores de disco no deben tumbar la app */
      }
    };
    this.queue.push(task);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    let task: (() => Promise<void>) | undefined;
    while ((task = this.queue.shift())) {
      await task();
    }
    this.writing = false;
  }

  /** Limpia archivos antiguos (> MAX_AGE_DAYS) y excedentes de rotación. */
  async cleanup(): Promise<void> {
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    let files: string[] = [];
    try {
      files = await this.listLogFiles(LOG_DIR);
    } catch {
      return;
    }

    for (const file of files) {
      try {
        const st = await fs.stat(file);
        if (st.mtimeMs < cutoff) {
          await fs.rm(file, { force: true });
        }
      } catch {
        /* noop */
      }
    }

    // Si quedan más de MAX_ROTATED_FILES archivos *.log.* rotados, borra los más antiguos.
    try {
      const rotated: string[] = [];
      for (const f of files) {
        if (/\.log\.\d+$/.test(f)) rotated.push(f);
      }
      if (rotated.length > MAX_ROTATED_FILES) {
        // Ordena por mtime y borra los más antiguos que excedan el tope.
        const stats = await Promise.all(rotated.map((f) => fs.stat(f).then((s) => ({ f, m: s.mtimeMs }))));
        stats.sort((a, b) => a.m - b.m);
        const toDelete = stats.slice(0, stats.length - MAX_ROTATED_FILES);
        for (const { f } of toDelete) {
          await fs.rm(f, { force: true }).catch(() => undefined);
        }
      }
    } catch {
      /* noop */
    }
  }

  private async listLogFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.name.endsWith(".log") || /\.log\.\d+$/.test(e.name)) {
          out.push(full);
        }
      }
    };
    await walk(dir);
    return out;
  }

  dispose(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}

export const logFile = new LogFileTransport();
