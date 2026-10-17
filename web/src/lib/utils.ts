import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function timeOnly(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("es-ES", { hour12: false });
  } catch {
    return iso.slice(11, 19);
  }
}

/** Distancia en español: "en 5 min", "hace 2 h", "ahora mismo", "—". */
export function formatDistanceEs(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = t - Date.now();
  const future = diff >= 0;
  const s = Math.round(Math.abs(diff) / 1000);
  if (s < 45) return "ahora mismo";
  if (s < 90) return future ? "en 1 min" : "hace 1 min";
  const m = Math.round(s / 60);
  if (m < 60) return future ? `en ${m} min` : `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return future ? `en ${h} h` : `hace ${h} h`;
  const d = Math.round(h / 24);
  return future ? `en ${d} d` : `hace ${d} d`;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${Math.round(ms / 100) / 10} s`;
}
