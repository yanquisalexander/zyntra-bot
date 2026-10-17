import {
  budgetsFor,
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
  parseToolCalls,
  stripToolBlocks,
  classifyArtifact,
  type Artifact,
  type FixInput,
} from "./prompts.js";
import { changedFiles, checkSyntax, executeTool, normalizeDraftPath, type DraftState } from "./tools.js";
import {
  ensureEngine,
  fetchDocs,
  currentContextWindow,
  generateFix,
  type EngineLike,
} from "./engine.js";

export interface HistoryMsg {
  role: "user" | "assistant";
  content: string;
}

export interface StepEvent {
  kind: "thinking" | "tool-call" | "tool-result" | "done" | "error";
  text: string;
  ok?: boolean;
}

export interface AgentCallbacks {
  onProgress(p: number, text: string): void;
  onToken(partial: string): void;
  onStep(e: StepEvent): void;
  isCancelled(): boolean;
}

const MAX_ITERATIONS = 6;
const MAX_TOOL_RESULT = 2000;

function capResult(message: string): string {
  if (message.length <= MAX_TOOL_RESULT) return message;
  return message.slice(0, MAX_TOOL_RESULT) + "\n…(resultado recortado)";
}

async function streamTurn(
  eng: EngineLike,
  messages: { role: string; content: string }[],
  cb: AgentCallbacks,
): Promise<string> {
  const stream = (await eng.chat.completions.create({
    messages,
    // El agente depende de emitir JSON de tools y seguir un protocolo fijo.
    // Menos variación reduce llamadas malformadas y ediciones inventadas.
    temperature: 0.15,
    max_tokens: 1200,
    stream: true,
  })) as unknown as AsyncIterable<{
    choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
  }>;
  let full = "";
  for await (const chunk of stream) {
    if (cb.isCancelled()) break;
    const delta =
      chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
    if (delta) {
      full += delta;
    }
  }
  return full;
}

function toolLabel(name: string, path?: string): string {
  const names: Record<string, string> = {
    "read-file": "leyendo",
    "edit-file": "editando",
    "check-syntax": "validando sintaxis de",
    "show-diff": "preparando cambios de",
  };
  return `${names[name] ?? name} ${path ?? ""}`.trim();
}

export interface AgentTurnResult {
  text: string;
  artifact: Artifact;
  steps: number;
  cancelled: boolean;
}

/**
 * Un turno del agente: genera, ejecuta las tools que pida el modelo
 * (read/edit/check/show) y repite hasta respuesta final o tope.
 * Todo cae en el DraftState (borrador); nada toca disco ni el editor.
 */
export async function runAgentTurn(
  store: DraftState,
  input: FixInput,
  instruction: string | undefined,
  model: string,
  history: HistoryMsg[],
  cb: AgentCallbacks,
): Promise<AgentTurnResult> {
  const eng = await ensureEngine(model, cb.onProgress);
  const docs = await fetchDocs();
  const budgets = budgetsFor(currentContextWindow());
  const system = buildAgentSystemPrompt(docs.markdown, docs.dts, budgets);

  // Historial previo (cola) sin pasar medio presupuesto.
  const tail: HistoryMsg[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (used + h.content.length > budgets.total / 2) break;
    tail.unshift(h);
    used += h.content.length;
  }
  const messages: { role: string; content: string }[] = [
    { role: "system", content: system },
    ...tail,
    { role: "user", content: buildAgentUserPrompt(input, instruction, budgets) },
  ];
  const draftAtStart = { ...store.draft };

  let steps = 0;
  // Anti-bucle: los modelos pequeños repiten la misma llamada cuando se
  // atascan. Se cachea cada llamada idéntica (no se re-ejecuta) y si insiste
  // 3 veces o encadena 3 errores, se corta con lo que haya en el borrador.
  const seen = new Map<string, { count: number; result: string; ok: boolean }>();
  let consecutiveErrors = 0;
  let emptyCount = 0;
  let noProgressCount = 0;
  const requestedChange = /(?:añad|agreg|crea|implementa|modifica|cambia|actualiza|arregla|corrige|elimina|borra|\badd\b|\bcreate\b|\bimplement\b|\bmodify\b|\bchange\b|\bupdate\b|\bfix\b|\bremove\b)/i.test(
    instruction ?? "",
  );
  // El show-diff solo cierra si plugin.js (tocado) pasó check-syntax en este
  // turno; si no, se valida solo y se le pide al modelo que revise y cierre.
  let checkedClean = false;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (cb.isCancelled()) {
      return { text: "", artifact: { kind: "explanation" }, steps, cancelled: true };
    }
    cb.onStep({ kind: "thinking", text: iter === 0 ? "Pensando…" : "Revisando el resultado…" });
    cb.onToken("");
    const full = await streamTurn(eng, messages, cb);
    if (cb.isCancelled()) {
      return { text: "", artifact: { kind: "explanation" }, steps, cancelled: true };
    }
    if (!full.trim()) {
      throw new Error("el modelo no devolvió nada (prueba con otro modelo)");
    }
    messages.push({ role: "assistant", content: full });
    const calls = parseToolCalls(full);
    // Respuesta hueca (solo cercas vacías, degeneración de modelos pequeños):
    // no se devuelve ni se cuenta como final, se le pide reintentar con
    // contenido real. Al segundo intento se corta con mensaje claro.
    if (calls.length === 0 && !stripToolBlocks(full)) {
      emptyCount += 1;
      cb.onStep({ kind: "tool-result", text: "respuesta vacía, reintentando…", ok: false });
      if (emptyCount >= 2) {
        const text =
          "El modelo devolvió bloques vacíos dos veces — no conseguí una respuesta útil. Prueba con otro modelo o reformula la petición.";
        cb.onStep({ kind: "done", text });
        return { text, artifact: { kind: "explanation" }, steps, cancelled: false };
      }
      messages.push({
        role: "user",
        content:
          "Tu respuesta llegó vacía (solo cercas ``` sin contenido). Reintenta: razona en <think>, usa bloques ```tool válidos con JSON real, o responde con texto y código de verdad.",
      });
      continue;
    }
    if (calls.length === 0) {
      // No permitir que una petición de cambio termine con el código original
      // como artefacto: la UI solo aplica DraftState y ese falso éxito no
      // produce ningún cambio. Obligar al modelo a usar read/edit/show-diff.
      const changedThisTurn = Object.keys(draftAtStart).some(
        (path) => store.draft[path as keyof typeof draftAtStart] !== draftAtStart[path as keyof typeof draftAtStart],
      );
      if (requestedChange && !changedThisTurn) {
        noProgressCount += 1;
        cb.onStep({
          kind: "tool-result",
          text: "no se aplicaron cambios; pidiendo que edite el borrador",
          ok: false,
        });
        if (noProgressCount >= 2) {
          cb.onStep({ kind: "thinking", text: "Probando generación completa como recuperación…" });
          try {
            const fallback = await generateFix(
              { ...input, code: store.draft["plugin.js"] },
              {
                model,
                customInstruction: `Edita el archivo completo para cumplir esta petición: ${instruction}\nDevuelve el plugin.js completo, conserva todo lo que ya funciona y no expliques ni inventes APIs.`,
                onProgress: cb.onProgress,
              },
            );
            const check = checkSyntax(fallback);
            if (fallback.trim() && fallback.trim() !== store.draft["plugin.js"].trim() && check.ok) {
              store.draft["plugin.js"] = fallback;
              const touched = changedFiles(store);
              const text = `Generé un borrador completo y pasó la validación de sintaxis. Revísalo en Cambios antes de aplicarlo.\n\nArchivos modificados: ${touched.join(", ") || "plugin.js"}`;
              cb.onStep({ kind: "tool-result", text: check.message, ok: true });
              cb.onStep({ kind: "done", text: "Borrador listo para revisar" });
              return {
                text,
                artifact: { kind: "code", code: fallback, lang: "js" },
                steps,
                cancelled: false,
              };
            }
          } catch (e) {
            cb.onStep({
              kind: "tool-result",
              text: `La generación de recuperación falló: ${String(e instanceof Error ? e.message : e).slice(0, 140)}`,
              ok: false,
            });
          }
          const text =
            "No se aplicaron cambios: el agente no pudo editar el borrador y la generación completa no produjo un plugin.js nuevo con sintaxis válida. Prueba con Qwen Coder 3B o divide la petición en pasos más pequeños.";
          cb.onStep({ kind: "done", text });
          return { text, artifact: { kind: "explanation" }, steps, cancelled: false };
        }
        messages.push({
          role: "user",
          content:
            "La petición requiere modificar el plugin, pero no has ejecutado ninguna edición y el borrador sigue igual. No devuelvas ni repitas el código actual. Lee el archivo con read-file, aplica el cambio pedido usando edit-file, ejecuta check-syntax y termina con show-diff. Si no puedes hacerlo, dilo sin afirmar que está listo.",
        });
        continue;
      }
      const text = stripToolBlocks(full);
      cb.onStep({ kind: "done", text: "Listo ✓" });
      return { text, artifact: classifyArtifact(full), steps, cancelled: false };
    }
    steps += calls.length;
    let finished = false;
    let stuck = false;
    for (const call of calls) {
      const key = JSON.stringify(call);
      const prev = seen.get(key);
      if (prev) {
        prev.count += 1;
        cb.onStep({ kind: "tool-call", text: `${toolLabel(call.name, call.path)} (repetida)` });
        if (prev.count >= 3) {
          stuck = true;
          break;
        }
        messages.push({
          role: "user",
          content: prev.ok
            ? `[tool ${call.name}${call.path ? ` ${call.path}` : ""}] OK (no ejecutada otra vez; llamada idéntica):\n${prev.result}\nNo repitas esta llamada; continúa con una acción nueva o termina con show-diff.`
            : `[tool ${call.name}${call.path ? ` ${call.path}` : ""}] ERROR (no ejecutada otra vez; llamada idéntica):\n${prev.result}\nLa llamada anterior FALLÓ. Para edit-file, lee ahora el archivo con read-file, copia una línea ancla actual y formula una edición distinta. No vuelvas a enviar el mismo bloque.`,
        });
        continue;
      }
      cb.onStep({ kind: "tool-call", text: toolLabel(call.name, call.path) });
      const res = executeTool(store, call);
      seen.set(key, { count: 1, result: capResult(res.message), ok: res.ok });
      if (call.name === "check-syntax" && res.ok) checkedClean = true;
      if (call.name === "edit-file" && res.ok && normalizeDraftPath(call.path) === "plugin.js") {
        checkedClean = false;
      }
      if (res.ok) {
        consecutiveErrors = 0;
      } else {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 3) {
          stuck = true;
          messages.push({
            role: "user",
            content: `[tool ${call.name}] ERROR:\n${capResult(res.message)}`,
          });
          break;
        }
      }
      cb.onStep({ kind: "tool-result", text: res.message.slice(0, 160), ok: res.ok });
      messages.push({
        role: "user",
        content: `[tool ${call.name}${call.path ? ` ${call.path}` : ""}] ${res.ok ? "ok" : "ERROR"}:\n${capResult(res.message)}`,
      });
      if (call.name === "show-diff") {
        const touched = changedFiles(store);
        if (touched.includes("plugin.js") && !checkedClean) {
          // El modelo quiso cerrar sin validar: se valida por él y sigue el loop.
          cb.onStep({ kind: "tool-call", text: "validando sintaxis de plugin.js (auto)" });
          const check = executeTool(store, { name: "check-syntax" });
          cb.onStep({ kind: "tool-result", text: check.message.slice(0, 160), ok: check.ok });
          if (check.ok) checkedClean = true;
          messages.push({
            role: "user",
            content: `[tool check-syntax] ${check.ok ? "ok" : "ERROR"}:\n${capResult(check.message)}\n${check.ok ? "Validación lista: revisa que cumpliste la petición completa y termina con show-diff." : "Corrige el error de sintaxis y vuelve a validar antes de show-diff."}`,
          });
          continue;
        }
        finished = true;
      }
    }
    if (stuck) {
      const text =
        "Me estanqué repitiendo el mismo paso — dejé lo que hay en la pestaña Cambios. Dime cómo seguir o ajusta la petición.";
      cb.onStep({ kind: "done", text });
      return { text, artifact: { kind: "explanation" }, steps, cancelled: false };
    }
    if (finished) {
      const lastProse = stripToolBlocks(full);
      const touched = changedFiles(store);
      const receipt =
        touched.length > 0
          ? `\n\nArchivos modificados: ${touched.join(", ")}`
          : "\n\nSin cambios en archivos.";
      const text = (lastProse || "Cambios listos — revísalos en la pestaña Cambios.") + receipt;
      cb.onStep({ kind: "done", text: "Listo ✓" });
      return { text, artifact: classifyArtifact(full), steps, cancelled: false };
    }
  }
  const text = "Me quedé sin iteraciones — revisa los cambios parciales en la pestaña Cambios.";
  cb.onStep({ kind: "done", text });
  return { text, artifact: { kind: "explanation" }, steps, cancelled: false };
}
