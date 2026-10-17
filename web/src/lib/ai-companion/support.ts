/** Detección de soporte WebLLM (WebGPU es lo que da velocidad útil). */
export function hasWebGPU(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export function hasWasmSimd(): boolean {
  // WebAssembly.SIMD no está estandarizado como flag; si hay WebAssembly
  // asumimos fallback CPU posible (lento). El check real lo hace el engine.
  return typeof WebAssembly !== "undefined";
}

export type SupportLevel = "ok" | "fallback";

export function supportLevel(): SupportLevel {
  return hasWebGPU() ? "ok" : "fallback";
}

export function supportHint(): string {
  if (hasWebGPU()) return "";
  return "Sin WebGPU: el modelo local no irá fino en este equipo. Usa el fallback (copiar prompt / ChatGPT) o prueba en Chrome/Edge con GPU.";
}
