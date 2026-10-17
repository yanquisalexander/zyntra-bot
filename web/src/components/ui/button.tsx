import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { RippleHost, useRipple } from "@/components/ui/ripple";

const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-xl text-sm font-bold whitespace-nowrap transition-all duration-150 ease-out outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-[#6e7aff]",
        secondary: "bg-secondary text-secondary-foreground hover:bg-[#2a2a2a]",
        outline:
          "border border-border bg-transparent hover:border-[#3a3a3a] hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive:
          "border border-[#ff5e5b33] bg-[#ff5e5b18] text-[#ff7a78] hover:bg-[#ff5e5b26]",
        success: "bg-[#00d4aa] text-[#06281f] hover:bg-[#4ce3c0]",
      },
      size: {
        default: "h-10 px-5 py-2",
        sm: "h-9 px-4 text-[13px]",
        xs: "h-8 px-3 text-xs",
        lg: "h-12 px-7 text-[15px]",
        icon: "h-10 w-10",
        "icon-sm": "h-8 w-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, onPointerDown, children, ...props }, ref) => {
    const { onPointerDown: rippleDown } = useRipple();
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        onPointerDown={(e) => {
          onPointerDown?.(e);
          rippleDown(e);
        }}
        {...props}
      >
        <RippleHost />
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
