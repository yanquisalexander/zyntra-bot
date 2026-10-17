import type { AgentToolCall } from "./prompts.js";

/** Archivos del plugin que el agente puede leer/tocar (nada fuera de aquí). */
export type DraftFile = "plugin.js" | "schema.yml" | "config.toml";

const DRAFT_FILES: DraftFile[] = ["plugin.js", "schema.yml", "config.toml"];

export function normalizeDraftPath(path: string | undefined): DraftFile | null {
  if (!path) return null;
  const p = path.trim().toLowerCase();
  return (DRAFT_FILES as string[]).includes(p) ? (p as DraftFile) : null;
}

export interface DraftState {
  /** Foto al abrir la sesión (el "temp git" baseline). */
  baseline: Record<DraftFile, string>;
  /** Borrador en memoria: solo aquí escriben las tools. */
  draft: Record<DraftFile, string>;
}

export function createDraftStore(initial: {
  code: string;
  schemaRaw: string;
  toml: string;
}): DraftState {
  const baseline: Record<DraftFile, string> = {
    "plugin.js": initial.code,
    "schema.yml": initial.schemaRaw,
    "config.toml": initial.toml,
  };
  return { baseline, draft: { ...baseline } };
}

/** El borrador sigue al editor: si el usuario edita a mano, re-baselina ese archivo. */
export function syncDraftWithEditor(
  store: DraftState,
  current: { code: string; schemaRaw: string; toml: string },
): void {
  const map: Record<DraftFile, string> = {
    "plugin.js": current.code,
    "schema.yml": current.schemaRaw,
    "config.toml": current.toml,
  };
  for (const f of DRAFT_FILES) {
    if (store.draft[f] === store.baseline[f] && store.baseline[f] !== map[f]) {
      // Sin cambios del agente en ese archivo: adopta lo del editor.
      store.baseline[f] = map[f];
      store.draft[f] = map[f];
    }
  }
}

export function changedFiles(store: DraftState): DraftFile[] {
  return DRAFT_FILES.filter((f) => store.draft[f] !== store.baseline[f]);
}

export function hasChanges(store: DraftState): boolean {
  return changedFiles(store).length > 0;
}

export function discardAll(store: DraftState): void {
  store.draft = { ...store.baseline };
}

/**
 * Tras aplicar al editor, el diff de esos archivos se vacía: lo aplicado
 * pasa a ser el nuevo baseline (lo que ves en Monaco ya es eso).
 */
export function markApplied(store: DraftState, files: DraftFile[]): void {
  for (const f of files) {
    if (store.draft[f] !== undefined) store.baseline[f] = store.draft[f];
  }
}

/** Localiza UNA línea ancla: exacta → sin espacios → agresiva (sin espacios ni comillas, solo para localizar). */
function findAnchorLine(lines: string[], anchor: string): number {
  const a = anchor.trim();
  if (!a) return -1;
  let idx = lines.findIndex((l) => l.trim() === a);
  if (idx !== -1) return idx;
  const norm = (s: string) => s.replace(/[\s'"`]/g, "");
  const na = norm(a);
  if (!na) return -1;
  idx = lines.findIndex((l) => norm(l) === na);
  if (idx !== -1) return idx;
  // Último recurso: contenencia con longitud mínima (evita falsos positivos).
  idx = lines.findIndex((l) => {
    const nl = norm(l);
    return nl.length > 10 && na.length > 10 && (nl.includes(na) || na.includes(nl));
  });
  return idx;
}

/** Extracto NUMERADO para que el modelo elija ancla y vea dónde está. */
function numberedExcerpt(fileText: string, from = 0, maxLines = 40): string {
  const lines = fileText.split("\n");
  const slice = lines.slice(from, from + maxLines);
  const out = slice.map((l, i) => `${from + i + 1}| ${l}`).join("\n");
  return (out.length > 1800 ? out.slice(0, 1800) + "\n…(recortado)" : out) +
    (from + maxLines < lines.length ? `\n…(+${lines.length - from - maxLines} líneas)` : "");
}

export interface ToolResult {
  ok: boolean;
  message: string;
}

/** Chequeo de sintaxis en el navegador: parsea sin ejecutar. */
export function checkSyntax(code: string): ToolResult {
  if (!code.trim()) return { ok: false, message: "syntax: el archivo está vacío" };
  try {
    // new Function parsea (no ejecuta). Limitación honesta: no valida la API
    // de Zyntra, solo que el JS parsea; la validación real sigue en Guardar.
    new Function(code);
    return { ok: true, message: "syntax OK: plugin.js parsea correctamente" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `syntax ERROR: ${msg.slice(0, 400)}` };
  }
}

/**
 * Ejecuta una tool-call contra el borrador. Nunca toca disco ni el editor:
 * el usuario aplica después desde el diff (ver DiffView / onApply).
 */
export function executeTool(store: DraftState, call: AgentToolCall): ToolResult {
  if (call.path?.startsWith("__invalid__:")) {
    return {
      ok: false,
      message:
        "tool ERROR: el bloque ```tool no es JSON válido. Reemite UN bloque por llamada con este formato exacto: ```tool {\"name\": \"edit-file\", \"path\": \"plugin.js\", \"anchor\": \"una línea del archivo\", \"mode\": \"after\", \"new\": \"...\"} ```",
    };
  }
  switch (call.name) {
    case "read-file": {
      const f = normalizeDraftPath(call.path);
      if (!f) {
        return {
          ok: false,
          message: `read-file ERROR: path inválido (${call.path ?? "vacío"}). Usa: plugin.js | schema.yml | config.toml`,
        };
      }
      return { ok: true, message: `== ${f} (líneas numeradas N| — NO copies los números en anchor) ==\n${numberedExcerpt(store.draft[f], 0, 300)}` };
    }
    case "edit-file": {
      const f = normalizeDraftPath(call.path);
      if (!f) {
        return {
          ok: false,
          message: `edit-file ERROR: path inválido (${call.path ?? "vacío"}). Usa: plugin.js | schema.yml | config.toml`,
        };
      }
      // Formato ancla (preferido): 1 línea distintiva + mode.
      if (typeof call.anchor === "string") {
        if (typeof call.new !== "string") {
          return { ok: false, message: "edit-file ERROR: falta `new` (el bloque a insertar)" };
        }
        const mode = call.mode === "before" || call.mode === "replace" ? call.mode : "after";
        const lines = store.draft[f].split("\n");
        const idx = findAnchorLine(lines, call.anchor);
        if (idx === -1) {
          return {
            ok: false,
            message: `edit-file ERROR: ancla no encontrada en ${f}. Elige UNA línea distintiva de este listado (sin los números) y reintenta:\n\`\`\`\n${numberedExcerpt(store.draft[f])}\n\`\`\``,
          };
        }
        if (mode === "before") lines.splice(idx, 0, call.new);
        else if (mode === "replace") lines.splice(idx, 1, call.new);
        else lines.splice(idx + 1, 0, call.new);
        store.draft[f] = lines.join("\n");
        return { ok: true, message: `edit-file OK (${mode} línea ${idx + 1}): ${f} actualizado en el borrador (pendiente de tu revisión en Cambios)` };
      }
      // Formato legacy old/new (compatibilidad).
      if (typeof call.old !== "string" || typeof call.new !== "string") {
        return { ok: false, message: "edit-file ERROR: usa el formato ancla: {\"name\":\"edit-file\",\"path\":\"plugin.js\",\"anchor\":\"una línea del archivo\",\"mode\":\"after\",\"new\":\"...\"}" };
      }
      if (!call.old) {
        return { ok: false, message: "edit-file ERROR: `old` vacío (usa el formato ancla en su lugar)" };
      }
      const idx = store.draft[f].indexOf(call.old);
      if (idx === -1) {
        return {
          ok: false,
          message: `edit-file ERROR: \`old\` no casa en ${f}. Mejor usa el formato ancla con UNA línea de este listado (sin los números):\n\`\`\`\n${numberedExcerpt(store.draft[f])}\n\`\`\``,
        };
      }
      store.draft[f] =
        store.draft[f].slice(0, idx) + call.new + store.draft[f].slice(idx + call.old.length);
      return { ok: true, message: `edit-file OK: ${f} actualizado en el borrador (pendiente de tu revisión en Cambios)` };
    }
    case "check-syntax": {
      return checkSyntax(store.draft["plugin.js"]);
    }
    case "show-diff": {
      const changed = changedFiles(store);
      if (changed.length === 0) {
        return { ok: true, message: "show-diff: no hay cambios en el borrador (todo igual al original)" };
      }
      return { ok: true, message: `show-diff: cambios listos en ${changed.join(", ")} — el usuario los revisará en la pestaña Cambios` };
    }
  }
}
