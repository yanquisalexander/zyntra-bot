import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  phase: "idle" | "loading" | "ready" | "generating" | "error";
  progress?: number; // 0-100
  text?: string;     // texto descriptivo de la fase (del callback onProgress del engine)
  message?: string;  // para error
}

export function ModelLoadBar({ phase, progress = 0, text, message }: Props) {
  // Para el auto-hide del badge "ready"
  const [readyVisible, setReadyVisible] = useState(false);
  const [readyFading, setReadyFading] = useState(false);

  useEffect(() => {
    if (phase !== "ready") {
      setReadyVisible(false);
      setReadyFading(false);
      return;
    }

    // Mostrar inmediatamente
    setReadyVisible(true);
    setReadyFading(false);

    // Fade-out a los 2.5 s, ocultar definitivamente a los 3 s
    const fadeTimer = setTimeout(() => setReadyFading(true), 2500);
    const hideTimer = setTimeout(() => setReadyVisible(false), 3000);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [phase]);

  // ── idle ──────────────────────────────────────────────────────────────────
  if (phase === "idle") return null;

  // ── loading ───────────────────────────────────────────────────────────────
  if (phase === "loading") {
    const clampedProgress = Math.min(100, Math.max(0, progress));
    const displayText =
      clampedProgress > 95 ? "Inicializando modelo…" : (text ?? "Descargando modelo…");

    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-[#a78bfa33] bg-[#141414] px-3 py-2.5">
        {/* Icono: Download mientras descarga, Loader2 al inicializar */}
        {clampedProgress > 95 ? (
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-[#a78bfa]" />
        ) : (
          <Download className="mt-0.5 size-4 shrink-0 text-[#a78bfa]" />
        )}

        <div className="min-w-0 flex-1 space-y-1.5">
          {/* Cabecera: etiqueta + porcentaje */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-white/90">Cargando modelo</span>
            <span className="shrink-0 text-[11px] tabular-nums text-[#a78bfa]">
              {clampedProgress}%
            </span>
          </div>

          {/* Barra de progreso */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full transition-[width] duration-300 ease-out"
              style={{ width: `${clampedProgress}%`, backgroundColor: "#a78bfa" }}
            />
          </div>

          {/* Texto de fase */}
          <p className="min-w-0 truncate text-[11px] text-zinc-500">{displayText}</p>
        </div>
      </div>
    );
  }

  // ── ready ─────────────────────────────────────────────────────────────────
  if (phase === "ready") {
    if (!readyVisible) return null;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-[#00d4aa44] bg-[#00d4aa15] px-2.5 py-0.5 text-[11px] font-semibold text-[#00d4aa] transition-opacity duration-500",
          readyFading ? "opacity-0" : "opacity-100",
        )}
      >
        ✓ Modelo listo
      </span>
    );
  }

  // ── generating ────────────────────────────────────────────────────────────
  if (phase === "generating") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#a78bfa33] bg-[#a78bfa15] px-2.5 py-0.5 text-[11px] font-semibold text-[#a78bfa]">
        <Loader2 className="size-3 animate-spin" />
        Generando…
      </span>
    );
  }

  // ── error ─────────────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <span
        className="inline-flex max-w-full items-start gap-1.5 rounded-full border border-[#ff7a7844] bg-[#ff7a7815] px-2.5 py-0.5 text-[11px] font-semibold text-[#ff7a78]"
        title={message}
      >
        <span className="shrink-0">✕</span>
        <span className="min-w-0 truncate">{message ?? "Error al cargar el modelo"}</span>
      </span>
    );
  }

  return null;
}
