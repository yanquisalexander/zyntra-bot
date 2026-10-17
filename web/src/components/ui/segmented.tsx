import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Icono en reposo; al seleccionar se cambia por el check. */
  icon?: React.ReactNode;
  /** Punto (p. ej. "sin guardar") visible en ambos estados. */
  dot?: boolean;
}

/**
 * Grupo unido con el segmento activo en blurple.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex max-w-full items-stretch divide-x divide-border overflow-x-auto rounded-xl border border-border bg-[#1a1a1a]",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative flex h-10 shrink-0 items-center gap-1.5 px-4 text-[13px] font-bold whitespace-nowrap transition-colors duration-150",
              active
                ? "bg-primary text-white"
                : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
            )}
          >
            {active ? (
              <Check key="check" className="size-4 animate-pop-in" strokeWidth={3} />
            ) : (
              o.icon
            )}
            {o.label}
            {o.dot && (
              <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-[#ffb700]" />
            )}
          </button>
        );
      })}
    </div>
  );
}
