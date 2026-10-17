import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn("inline-flex shrink-0 items-center gap-2.5", className)}
    >
      <span
        className={cn(
          "flex h-6 w-11 items-center rounded-full px-[3px] transition-colors duration-150",
          checked ? "bg-primary" : "bg-[#2e2a26]",
        )}
      >
        <span
          className={cn(
            "size-[18px] rounded-full bg-white shadow transition-transform duration-150 ease-out",
            checked ? "translate-x-5" : "translate-x-0",
          )}
        />
      </span>
      {label && <span className="text-[13px] font-bold text-muted-foreground">{label}</span>}
    </button>
  );
}
