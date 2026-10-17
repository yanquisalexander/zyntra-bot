import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Chips tintados estilo Alexitoo: borde + fondo + texto del mismo color. */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold whitespace-nowrap transition-colors",
  {
    variants: {
      variant: {
        default: "border-[#5865f233] bg-[#5865f211] text-[#8b93ff]",
        secondary: "border-[#2e2e2e] bg-[#1e1e1e] text-[#a8a094]",
        success: "border-[#00d4aa33] bg-[#00d4aa11] text-[#00d4aa]",
        destructive: "border-[#ff5e5b33] bg-[#ff5e5b11] text-[#ff7a78]",
        warning: "border-[#ffb70033] bg-[#ffb70011] text-[#ffb700]",
        violet: "border-[#a78bfa33] bg-[#a78bfa11] text-[#a78bfa]",
        pink: "border-[#f7258533] bg-[#f7258511] text-[#f75d9d]",
        outline: "border-border text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
