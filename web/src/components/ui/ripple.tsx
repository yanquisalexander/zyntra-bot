import { useCallback, useRef } from "react";

/**
 * Ripple estilo M3 para controles con pulsación.
 * Se coloca dentro de un contenedor `relative overflow-hidden`; en cada
 * pointerdown genera una onda radial que se expande y desvanece con la
 * curva emphasized. Respeta prefers-reduced-motion (no hace nada).
 */
export function RippleHost() {
  return (
    <span
      aria-hidden
      data-ripple-host
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
    />
  );
}

export function useRipple() {
  const fallbackRef = useRef<HTMLSpanElement | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const btn = e.currentTarget;
    const host =
      (btn.querySelector("[data-ripple-host]") as HTMLElement | null) ??
      fallbackRef.current;
    if (!host) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.3;
    const s = document.createElement("span");
    s.className = "zyn-ripple";
    s.style.width = `${size}px`;
    s.style.height = `${size}px`;
    s.style.left = `${e.clientX - rect.left - size / 2}px`;
    s.style.top = `${e.clientY - rect.top - size / 2}px`;
    s.style.background =
      "radial-gradient(circle, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0) 68%)";
    host.appendChild(s);
    const anim = s.animate(
      [
        { transform: "scale(0)", opacity: 1 },
        { transform: "scale(1)", opacity: 0 },
      ],
      { duration: 560, easing: "cubic-bezier(0.05, 0.7, 0.1, 1)" },
    );
    anim.onfinish = () => s.remove();
  }, []);

  return { onPointerDown, fallbackRef };
}
