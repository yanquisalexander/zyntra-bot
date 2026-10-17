import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="truncate font-display text-[26px] font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export type Tone = "blurple" | "violet" | "mint" | "yellow" | "pink" | "red" | "gray";

/** Caja de icono tintada estilo Alexitoo (borde + fondo del mismo color). */
const toneBox: Record<Tone, string> = {
  blurple: "border-[#5865f233] bg-[#5865f211] text-[#8b93ff]",
  violet: "border-[#a78bfa33] bg-[#a78bfa11] text-[#a78bfa]",
  mint: "border-[#00d4aa33] bg-[#00d4aa11] text-[#00d4aa]",
  yellow: "border-[#ffb70033] bg-[#ffb70011] text-[#ffb700]",
  pink: "border-[#f7258533] bg-[#f7258511] text-[#f75d9d]",
  red: "border-[#ff5e5b33] bg-[#ff5e5b11] text-[#ff7a78]",
  gray: "border-[#2e2e2e] bg-[#1e1e1e] text-[#a8a094]",
};

export function IconBox({
  tone = "blurple",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-xl border text-xl",
        toneBox[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}

const statusMap: Record<string, { variant: "success" | "destructive" | "warning" | "secondary"; dot: string; label: string; tone: Tone }> = {
  active: { variant: "success", dot: "bg-[#00d4aa]", label: "activo", tone: "mint" },
  error: { variant: "destructive", dot: "bg-[#ff5e5b]", label: "con error", tone: "red" },
  loading: { variant: "warning", dot: "bg-[#ffb700] animate-pulse", label: "cargando", tone: "yellow" },
  unloading: { variant: "warning", dot: "bg-[#ffb700] animate-pulse", label: "deteniendo", tone: "yellow" },
  disabled: { variant: "secondary", dot: "bg-zinc-500", label: "desactivado", tone: "gray" },
};

/** Etiqueta en lenguaje del panel para un estado interno del plugin. */
export const statusText = (status: string) => statusMap[status]?.label ?? status;

/** Tono de un estado (para icon-boxes y acentos). */
export const statusTone = (status: string): Tone => statusMap[status]?.tone ?? "gray";

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const s = statusMap[status] ?? statusMap.disabled;
  return (
    <Badge variant={s.variant} className={className}>
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </Badge>
  );
}

/** Subrayado dibujado a mano, como los titulares de Alexitoo. */
export function Squiggle({ className, stroke = "#f72585" }: { className?: string; stroke?: string }) {
  return (
    <svg viewBox="0 0 200 10" fill="none" className={className} aria-hidden>
      <path
        d="M2 7 C30 2, 60 9, 100 5 C140 1, 170 8, 198 4"
        stroke={stroke}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Palabra con squiggle debajo (titulares con carácter). */
export function Waved({ children, stroke }: { children: ReactNode; stroke?: string }) {
  return (
    <span className="relative inline-block whitespace-nowrap">
      {children}
      <Squiggle stroke={stroke} className="absolute -bottom-1.5 left-0 h-[9px] w-full" />
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
  emoji = "📦",
  tone = "violet",
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  emoji?: string;
  tone?: Tone;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
      <IconBox tone={tone} className="size-14 text-3xl">
        {emoji}
      </IconBox>
      <p className="mt-1 font-display text-xl font-semibold tracking-tight">{title}</p>
      {description && <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function AlertError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="rounded-xl border border-[#ff5e5b33] bg-[#ff5e5b11] px-4 py-3 text-sm leading-relaxed font-semibold text-[#ff7a78]">
      {message}
    </div>
  );
}

export function AlertOk({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="rounded-xl border border-[#00d4aa33] bg-[#00d4aa11] px-4 py-3 text-sm font-semibold text-[#00d4aa]">
      {message}
    </div>
  );
}
