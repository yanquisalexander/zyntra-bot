/**
 * Modelos curados para el AI-Companion (arreglar/crear plugin.js).
 *
 * Fuente: `prebuiltAppConfig` de @mlc-ai/web-llm
 * (https://github.com/mlc-ai/web-llm/blob/main/src/config.ts, `modelVersion`
 * de la v0_2_86 instalada). Solo IDs de esa lista: el engine los resuelve
 * sin `appConfig` extra. VRAM = `vram_required_MB` oficial.
 *
 * Se excluyen a propósito los variantes `-1k` (contexto de 1024: no cabe
 * el system prompt con docs + código) y los >4B (descarga y VRAM
 * excesivas para un fix en el panel).
 */
export interface CompanionModel {
  id: string;
  label: string;
  description: string;
  /** VRAM estimada oficial (MB). */
  vramMB: number;
  /** Especializado en código (mejor para fixes de plugin.js). */
  code: boolean;
}

export const AI_COMPANION_MODELS: CompanionModel[] = [
  {
    id: "gemma3-1b-it-q4f16_1-MLC",
    label: "Gemma 3 1B · ultraligero (~0.7 GB)",
    description: "El más pequeño con contexto completo. Equipos modestos.",
    vramMB: 711,
    code: false,
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 1B · ligero (~0.9 GB)",
    description: "Rápido y fiable para fixes simples.",
    vramMB: 879,
    code: false,
  },
  {
    id: "Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC",
    label: "Qwen Coder 0.5B · mini código (~0.9 GB)",
    description: "Especializado en código, para cambios pequeños y directos.",
    vramMB: 944,
    code: true,
  },
  {
    id: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
    label: "Qwen Coder 1.5B · código ligero (~1.6 GB)",
    description: "Útil para cambios acotados; puede fallar en tareas con varios pasos o tools.",
    vramMB: 1629,
    code: true,
  },
  {
    id: "SmolLM2-1.7B-Instruct-q4f16_1-MLC",
    label: "SmolLM2 1.7B (~1.8 GB)",
    description: "Alternativa general eficiente.",
    vramMB: 1774,
    code: false,
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 3B (~2.3 GB)",
    description: "Más calidad general. PC con margen.",
    vramMB: 2263,
    code: false,
  },
  {
    id: "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
    label: "Qwen Coder 3B · recomendado para código (~2.5 GB)",
    description: "Más fiable para cambios con varios pasos y revisión de herramientas. PC desahogada.",
    vramMB: 2504,
    code: true,
  },
];

export const DEFAULT_AI_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

export function modelLabel(id: string): string {
  return AI_COMPANION_MODELS.find((m) => m.id === id)?.label ?? id;
}

export function modelKnown(id: string): boolean {
  return AI_COMPANION_MODELS.some((m) => m.id === id);
}

export interface DeviceProfile {
  ramGB?: number;
  cores?: number;
  gpu: boolean;
}

/** Foto del equipo con APIs del navegador (pueden no existir → undefined). */
export function estimateDevice(): DeviceProfile {
  const nav = (
    typeof navigator !== "undefined" ? navigator : {}
  ) as Record<string, unknown>;
  const ramGB =
    typeof nav.deviceMemory === "number" ? (nav.deviceMemory as number) : undefined;
  const cores =
    typeof nav.hardwareConcurrency === "number"
      ? (nav.hardwareConcurrency as number)
      : undefined;
  return { ramGB, cores, gpu: "gpu" in nav };
}

export function deviceSummary(d: DeviceProfile = estimateDevice()): string {
  const ram = d.ramGB ? `${d.ramGB} GB RAM` : "RAM desconocida";
  const cores = d.cores ? `${d.cores} núcleos` : "núcleos desconocidos";
  const gpu = d.gpu ? "WebGPU sí" : "WebGPU no";
  return `${ram} · ${cores} · ${gpu}`;
}

export interface ModelRecommendation {
  id: string;
  reason: string;
}

/**
 * Elige el modelo más adecuado al equipo actual.
 * Null = sin WebGPU (no se recomienda ningún local → fallback externo).
 */
export function recommendModel(
  d: DeviceProfile = estimateDevice(),
): ModelRecommendation | null {
  if (!d.gpu) return null;
  if ((d.ramGB ?? 8) <= 4 || (d.cores ?? 8) <= 4) {
    return {
      id: "gemma3-1b-it-q4f16_1-MLC",
      reason: "equipo modesto: el más ligero con contexto completo",
    };
  }
  if ((d.ramGB ?? 8) <= 8 && (d.cores ?? 6) < 8) {
    return {
      id: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
      reason: "PC media: code-tuned con descarga razonable",
    };
  }
  return {
    id: "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
    reason: "PC desahogada: mejor calidad para fixes de JS",
  };
}
