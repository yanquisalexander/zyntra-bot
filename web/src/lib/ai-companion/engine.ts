import { budgetsFor, buildChatMessages, extractJsCode, type FixInput } from "./prompts.js";
import { DEFAULT_AI_MODEL } from "./models.js";
import CompanionWorker from "./companion.worker.ts?worker";
import type { AppConfig } from "@mlc-ai/web-llm";

export type LoadState =
  | { phase: "idle" }
  | { phase: "loading"; progress: number; text: string }
  | { phase: "ready" }
  | { phase: "generating" }
  | { phase: "error"; message: string };

export interface DocsContext {
  markdown: string;
  dts: string;
}

export type EngineLike = {
  chat: {
    completions: {
      create(args: Record<string, unknown>): Promise<AsyncIterable<unknown> & { choices?: Array<{ message?: { content?: string } }> }>;
    };
  };
  unload?: () => Promise<void>;
};

// Ventana de contexto efectiva del engine cargado (4096 por defecto).
// Se intenta subir a 8192 (más contexto = respuestas menos "tontas"); si la
// GPU no da para la KV-cache extra, se baja a 4096 con prompt recortado.
let effectiveWindow = 4096;
let windowLimited = false;

export function currentContextWindow(): number {
  return effectiveWindow;
}

export function contextWasLimited(): boolean {
  return windowLimited;
}

const WIDE_WINDOW = 8192;

// Singleton: un solo engine + worker por sesión.
let engine: EngineLike | null = null;
let engineModel = "";
let workerRef: Worker | null = null;
let loadingPromise: Promise<EngineLike> | null = null;

export async function fetchDocs(): Promise<DocsContext> {
  const res = await fetch("/api/docs/plugin-api?format=json");
  if (!res.ok) throw new Error("no se pudieron cargar los docs (recarga la página)");
  const d = (await res.json()) as DocsContext;
  return { markdown: d.markdown ?? "", dts: d.dts ?? "" };
}

export async function ensureEngine(
  model: string,
  onProgress: (p: number, text: string) => void,
): Promise<EngineLike> {
  if (engine && engineModel === model) return engine;
  if (loadingPromise && engineModel === model) return loadingPromise;
  // Cambio de modelo: soltar el anterior.
  try {
    await engine?.unload?.();
  } catch {
    /* noop */
  }
  try {
    workerRef?.terminate();
  } catch {
    /* noop */
  }
  engine = null;
  workerRef = null;

  engineModel = model || DEFAULT_AI_MODEL;
  loadingPromise = (async () => {
    const webllm = await import("@mlc-ai/web-llm");
    const onInit = (r: { progress?: number; text?: string }) => {
      onProgress(Math.round((r.progress ?? 0) * 100), r.text ?? "cargando…");
    };
    // appConfig con la ventana ampliada: se clona la ficha prebuilt del
    // modelo (URLs + wasm oficiales) cambiando solo la ventana. Se apaga
    // sliding_window_size (-1): si la config base del modelo trae sliding>0,
    // MLC exige que solo uno de los dos sea positivo y el init falla.
    const rec = webllm.prebuiltAppConfig?.model_list?.find(
      (m: { model_id?: string }) => m.model_id === engineModel,
    );
    const wideAppConfig: AppConfig | undefined = rec
      ? {
          model_list: [
            {
              ...rec,
              overrides: {
                ...(rec.overrides ?? {}),
                context_window_size: WIDE_WINDOW,
                sliding_window_size: -1,
              },
            },
          ],
        }
      : undefined;
    // Fallback 4k: misma protección (algunos modelos traen sliding>0 de base
    // y el init por defecto también chocaría).
    const narrowAppConfig: AppConfig | undefined = rec
      ? {
          model_list: [
            {
              ...rec,
              overrides: { ...(rec.overrides ?? {}), sliding_window_size: -1 },
            },
          ],
        }
      : undefined;

    const startWorker = (): Worker | null => {
      try {
        // En prod el Worker es same-origin (chunk del build). En dev la página
        // sale del backend (:3000) y el Worker de Vite (:5173): el constructor
        // lanza error síncrono por cross-origin → se usa el hilo principal.
        const worker = new CompanionWorker({ type: "module" });
        workerRef = worker;
        return worker;
      } catch {
        workerRef = null;
        return null;
      }
    };
    const initWith = async (worker: Worker | null, appConfig?: AppConfig) => {
      const cfg = {
        initProgressCallback: onInit,
        logLevel: "SILENT" as const,
        ...(appConfig ? { appConfig } : {}),
      };
      if (worker) {
        return (await webllm.CreateWebWorkerMLCEngine(worker, engineModel, cfg)) as unknown as EngineLike;
      }
      return (await webllm.CreateMLCEngine(engineModel, cfg)) as unknown as EngineLike;
    };

    let worker = startWorker();
    try {
      // 1º intento: ventana amplia (8k). Si la GPU no da para la KV-cache,
      // el init falla y se reintenta en 4k con el worker de repuesto.
      engine = await initWith(worker, wideAppConfig);
      effectiveWindow = wideAppConfig ? WIDE_WINDOW : 4096;
      windowLimited = false;
      return engine;
    } catch {
      try {
        worker?.terminate();
      } catch {
        /* noop */
      }
      workerRef = null;
      worker = startWorker();
      try {
        engine = await initWith(worker, narrowAppConfig);
      } catch {
        // Sin Worker (CSP estricta, etc.): mismo engine en el hilo principal.
        workerRef = null;
        engine = await initWith(null, undefined);
      }
      effectiveWindow = 4096;
      windowLimited = !!wideAppConfig;
      return engine;
    }
  })();
  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

export function unloadEngine() {
  loadingPromise = null;
  effectiveWindow = 4096;
  windowLimited = false;
  const e = engine;
  engine = null;
  engineModel = "";
  try {
    void e?.unload?.();
  } catch {
    /* noop */
  }
  try {
    workerRef?.terminate();
  } catch {
    /* noop */
  }
  workerRef = null;
}

export async function generateFix(
  input: FixInput,
  opts: {
    model: string;
    customInstruction?: string;
    onProgress: (p: number, text: string) => void;
    onToken?: (partial: string) => void;
  },
): Promise<string> {
  const eng = await ensureEngine(opts.model, opts.onProgress);
  const docs = await fetchDocs();
  const budgets = budgetsFor(currentContextWindow());
  const { system, user, trimmed } = buildChatMessages(
    docs.markdown,
    docs.dts,
    input,
    opts.customInstruction,
    budgets,
  );
  if (trimmed) {
    opts.onProgress(0, "Código largo: se envió resumido para que quepa en contexto…");
  }
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const stream = (await eng.chat.completions.create({
    messages,
    temperature: 0.2,
    max_tokens: 1500,
    stream: true,
  })) as unknown as AsyncIterable<{
    choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
  }>;
  let full = "";
  for await (const chunk of stream) {
    const delta =
      chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
    if (delta) {
      full += delta;
      opts.onToken?.(full);
    }
  }
  if (!full.trim()) throw new Error("el modelo no devolvió nada (prueba con el otro modelo)");
  return extractJsCode(full);
}
