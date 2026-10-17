export interface FixInput {
  code: string;
  lastError?: string;
  pluginName?: string;
  schemaRaw?: string;
  toml?: string;
}

export interface PromptBudgets {
  code: number;
  error: number;
  schema: number;
  docs: number;
  dts: number;
  total: number;
}

/**
 * Presupuestos según la ventana real del engine. Con 8k el prompt puede ser
 * ~4x mayor (≈4200 tokens) dejando sitio a la respuesta; con 4k hay que
 * recortar para no pasarse (el engine rechaza el prompt entero si se pasa).
 */
export function budgetsFor(windowTokens: number): PromptBudgets {
  if (windowTokens >= 8192) {
    return { code: 6000, error: 800, schema: 800, docs: 3000, dts: 4000, total: 16000 };
  }
  return { code: 2500, error: 500, schema: 500, docs: 1500, dts: 2000, total: 8000 };
}

function trunc(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "\n…(truncado)" : s;
}

export function buildSystemPrompt(markdown: string, dts: string, b: PromptBudgets = budgetsFor(4096)): string {
  return [
    "Eres el AI-Companion de Zyntra Bot. Solo respondes con plugin.js válido.",
    "Reglas: usa definePlugin({ name?, version?, setup(api) }), solo la api.* documentada.",
    "No importes discord.js (usa api.client). No while(true). Timeout setup 10s.",
    "Si hay error, corrígelo con el cambio mínimo. Responde con bloque ```js ... ``` y luego 1-3 líneas de explicación.",
    "",
    "== DOCS plugin-api.md ==",
    trunc(markdown, b.docs),
    "",
    "== plugin-api.d.ts (resumen) ==",
    trunc(dts, b.dts),
  ].join("\n");
}

export function buildFixUserPrompt(input: FixInput, customInstruction?: string, b: PromptBudgets = budgetsFor(4096)): string {
  const parts = [
    `Plugin: ${input.pluginName ?? "(sin nombre)"}`,
    customInstruction?.trim()
      ? `Petición: ${customInstruction.trim()}`
      : "Petición: crea / arregla el plugin. Devuelve el plugin.js completo corregido.",
  ];
  if (input.lastError?.trim()) {
    parts.push(`Último error:\n${trunc(input.lastError.trim(), b.error)}`);
  }
  parts.push(`Código actual (plugin.js):\n\`\`\`js\n${trunc(input.code, b.code)}\n\`\`\``);
  if (input.schemaRaw?.trim()) {
    parts.push(`schema.yml (contexto, no lo reescribas salvo que se pida):\n\`\`\`yaml\n${trunc(input.schemaRaw, b.schema)}\n\`\`\``);
  }
  return parts.join("\n\n");
}

/**
 * Monta system + user garantizando que juntos no pasan el tope.
 * Devuelve también si hubo que recortar de más (para avisarlo en la UI).
 */
export function buildChatMessages(
  markdown: string,
  dts: string,
  input: FixInput,
  customInstruction?: string,
  b: PromptBudgets = budgetsFor(4096),
): { system: string; user: string; trimmed: boolean } {
  const system = buildSystemPrompt(markdown, dts, b);
  let codeBudget = b.code;
  let user = buildFixUserPrompt({ ...input }, customInstruction, b);
  // Reescribe el user con presupuestos de código menguantes hasta encajar.
  let guard = 0;
  while (system.length + user.length > b.total && codeBudget > 400 && guard++ < 8) {
    codeBudget = Math.floor(codeBudget * 0.6);
    const code = trunc(input.code, codeBudget);
    user = buildFixUserPrompt({ ...input, code }, customInstruction, b);
  }
  return { system, user, trimmed: codeBudget < b.code };
}

/** Prompt portable para pegar en ChatGPT (no puede fetchear localhost). */
export function buildExternalPrompt(
  input: FixInput,
  docsUrl: string,
  customInstruction?: string,
): string {
  const b = budgetsFor(4096);
  return [
    customInstruction?.trim()
      ? customInstruction.trim()
      : "Arréglame este plugin de Zyntra Bot y devuélveme el plugin.js completo.",
    "",
    `Plugin: ${input.pluginName ?? "(sin nombre)"}`,
    input.lastError?.trim() ? `Error:\n${trunc(input.lastError.trim(), b.error)}` : "",
    `Código:\n\`\`\`js\n${trunc(input.code, b.code)}\n\`\`\``,
    "Contexto API (resumen): definePlugin({ setup(api) }), api.config, api.botConfig.prefix,",
    "api.events.on/off (discord o bus plugin:evento), api.emit, api.commands.register/unregister (slash: {description, options}), api.sendMessage/reply/sendEmbed,",
    "api.log.info/warn/error, api.onCleanup, api.jobs.every/cron/in/at, api.vars.get/set/incr/decr/reset/has/all, api.ui.*,",
    "api.ui.discord.button/selectMenu/modal (componentes Discord), api.http.get/post (rutas públicas /plugin-routes/<plugin>/<path>, {raw:true} para firmas HMAC), api.lib.pkg/importUrl.",
    `Docs raw (pública, sin login): ${docsUrl} — Fetch ${docsUrl} and then fix the code.`,
    "Si no puedes hacer fetch, trabaja con el resumen y el código de abajo.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Límite seguro para el valor `q` ya codificado. Las URLs larguísimas se ven
 * bien en la barra del navegador, pero por el camino hay topes reales:
 * servidores/proxies que devuelven 414 a partir de ~8 KB y parámetros que el
 * destino puede truncar. 3000 caracteres codificados (~3 KB de URL total)
 * pasan en la práctica totalidad de casos.
 */
const MAX_Q_ENCODED = 3000;

/** Una línea de contexto mínimo por si el LLM no puede hacer fetch. */
const API_ONE_LINER =
  "API: definePlugin({setup(api)}), api.config, api.events.on/off, api.emit, api.commands.register, " +
  "api.sendMessage/reply/sendEmbed, api.log, api.jobs.every/cron/in/at, api.vars.get/set/incr, api.ui.*, " +
  "api.http.get/post (/plugin-routes/<plugin>/<path>), api.lib.pkg/importUrl.";

/**
 * Versión compacta del prompt pensada para ir en la URL (`?q=`).
 * Recorta el código lo justo para no pasar MAX_Q_ENCODED y avisa con
 * `truncated` para mostrarlo en la UI. El botón de copiar sigue llevando
 * la versión completa (el portapapeles no tiene este límite).
 */
export function buildChatComLink(
  input: FixInput,
  docsUrl: string,
  customInstruction?: string,
): { url: string; truncated: boolean } {
  const ask = (
    customInstruction?.trim() ||
    "Arréglame este plugin de Zyntra Bot y devuelve el plugin.js completo."
  ).slice(0, 300);
  const err = input.lastError?.trim()
    ? `Error:\n${input.lastError.trim().slice(0, 300)}`
    : "";
  const build = (codeSnippet: string, cut: boolean) =>
    [
      ask,
      `Plugin: ${input.pluginName ?? "(sin nombre)"}`,
      err,
      API_ONE_LINER,
      `Docs: fetch ${docsUrl} and then fix the code.`,
      `Código:\n\`\`\`js\n${codeSnippet}\n\`\`\`${cut ? "\n(código recortado por límite de URL: pide el resto o usa el prompt completo)" : ""}`,
    ]
      .filter(Boolean)
      .join("\n\n");

  let snippet = input.code;
  let text = build(snippet, false);
  // Recorte iterativo: la expansión al codificar varía (~2-3x en código),
  // así que se mide el resultado real en vez de estimar.
  let guard = 0;
  while (encodeURIComponent(text).length > MAX_Q_ENCODED && snippet.length > 200 && guard++ < 10) {
    snippet = snippet.slice(0, Math.floor(snippet.length * 0.6));
    text = build(snippet, true);
  }
  if (encodeURIComponent(text).length > MAX_Q_ENCODED) {
    // Caso extremo (error larguísimo, etc.): solo instrucción + fetch.
    text = [ask, API_ONE_LINER, `Docs: fetch ${docsUrl} and then fix the code.`].join("\n\n");
  }
  return {
    url: `https://chat.com/?q=${encodeURIComponent(text)}`,
    truncated: snippet.length < input.code.length,
  };
}

export function extractJsCode(answer: string): string {
  const m = answer.match(/```(?:js|javascript)?\n([\s\S]*?)```/i);
  if (m) return m[1].trim();
  return answer.trim();
}

// ---------------------------------------------------------------------------
// Modo agente (chat estilo OpenCode): el modelo trabaja por iteraciones
// emitiendo tool-calls en bloques cercados, que el frontend ejecuta.
// ---------------------------------------------------------------------------

export const AGENT_TOOL_NAMES = ["read-file", "edit-file", "check-syntax", "show-diff"] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface AgentToolCall {
  name: AgentToolName;
  path?: string;
  old?: string;
  new?: string;
  anchor?: string;
  mode?: string;
}

const TOOL_FENCE_RE = /```tool\s*\n([\s\S]*?)```/gi;

/** Extrae tool-calls ` ```tool {"name": ...} ` del texto (tolerante a JSON con desperfectos menores). */
export function parseToolCalls(text: string): AgentToolCall[] {
  const out: AgentToolCall[] = [];
  TOOL_FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_FENCE_RE.exec(text)) !== null) {
    const raw = m[1].trim();
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (typeof obj.name !== "string") continue;
      const name = obj.name as string;
      if (!(AGENT_TOOL_NAMES as readonly string[]).includes(name)) continue;
      out.push({
        name: name as AgentToolName,
        path: typeof obj.path === "string" ? obj.path : undefined,
        old: typeof obj.old === "string" ? obj.old : undefined,
        new: typeof obj.new === "string" ? obj.new : undefined,
        anchor: typeof obj.anchor === "string" ? obj.anchor : undefined,
        mode: typeof obj.mode === "string" ? obj.mode : undefined,
      });
    } catch {
      // JSON malformado: se ignora y el loop le pedirá reintento al modelo.
      out.push({ name: "read-file", path: `__invalid__:${raw.slice(0, 80)}` });
    }
  }
  return out;
}

/** Quita los bloques ```tool del texto visible (ya se muestran como timeline). */
export function stripToolBlocks(text: string): string {
  TOOL_FENCE_RE.lastIndex = 0;
  return text.replace(TOOL_FENCE_RE, "").trim();
}

/**
 * Texto para pintar EN DIRECTO mientras streamnea: quita las tool-calls
 * (cerradas o a medias, que ya van al timeline) pero deja el resto
 * (razonamiento, prosa, bloques de código) para ver el progreso real.
 */
export function visibleStreamingText(text: string): string {
  TOOL_FENCE_RE.lastIndex = 0;
  return text
    .replace(TOOL_FENCE_RE, "")
    .replace(/```tool[\s\S]*$/i, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

/** Elimina todo el contenido interno <think>, también si quedó abierto al truncarse. */
export function stripThinkingBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

/** Compatibilidad con la UI: el razonamiento se descarta y nunca se muestra. */
export function extractThinking(text: string): { thinking: string; rest: string } {
  return { thinking: "", rest: stripThinkingBlocks(text) };
}

export type ArtifactKind = "code" | "explanation";

export interface Artifact {
  kind: ArtifactKind;
  /** Solo en kind === "code": el código propuesto. */
  code?: string;
  lang?: string;
}

/**
 * Clasifica la respuesta final: si trae bloque de código es artefacto `code`
 * (ofrece ver diff / aplicar); si no, `explanation` (solo copiar).
 */
export function classifyArtifact(text: string): Artifact {
  const noTools = stripToolBlocks(text);
  const rest = stripThinkingBlocks(noTools);
  const m = rest.match(/```(js|javascript|yaml|toml)?\n([\s\S]*?)```/i);
  if (m && m[2].trim()) {
    return { kind: "code", code: m[2].trim(), lang: (m[1] || "js").toLowerCase() };
  }
  return { kind: "explanation" };
}

/** System prompt del modo agente: rol + catálogo de tools + protocolo del loop. */
export function buildAgentSystemPrompt(markdown: string, dts: string, b: PromptBudgets = budgetsFor(4096)): string {
  return [
    "Eres el AI-Companion de Zyntra Bot, un asistente de código que trabaja POR PASOS usando herramientas.",
    "",
    "⛔ REGLA CRÍTICA — PROHIBIDO VOLCAR ARCHIVOS:",
    "NUNCA repitas ni copies el contenido de los archivos en la respuesta, en texto plano ni en bloques de código. Los archivos los lee el usuario desde el editor. Si necesitas mostrar código, usa edit-file en el borrador.",
    "No emitas bloques ```js ni ```javascript con el archivo completo. Si el modelo anterior lo hacía, ignora ese patrón.",
    "Las únicas respuestas válidas son: texto breve de plan/resumen + bloques ```tool, o prosa sin código si solo explicas.",
    "",
    "Reglas del plugin: definePlugin({ name?, version?, setup(api) }), solo la api.* documentada.",
    "No importes discord.js (usa api.client). No while(true). Timeout setup 10s.",
    "Si hay error, corrígelo con el cambio mínimo.",
    "",
    "HERRAMIENTAS (un bloque por llamada, JSON en una sola línea si puedes):",
    "```tool",
    '{"name": "read-file", "path": "plugin.js"}',
    "```",
    "- read-file: lee plugin.js | schema.yml | config.toml (devuelve líneas NUMERADAS como `12| código`; no copies los números).",
    "- edit-file: edita por LÍNEA ANCLA (no copies bloques enteros): {\"name\":\"edit-file\",\"path\":\"plugin.js\",\"anchor\":\"una línea distintiva tal cual\",\"mode\":\"after\",\"new\":\"bloque nuevo\"}. Modos: after (inserta debajo, lo normal), before (encima), replace (sustituye esa línea).",
    "- check-syntax: valida la sintaxis del borrador de plugin.js.",
    "- show-diff: termina y muestra al usuario la pestaña de cambios.",
    "",
    "PROTOCOLO:",
    "1. Lee el archivo con read-file para obtener líneas numeradas. No emitas su contenido en texto visible. Elige UNA línea ancla distintiva (tal cual, sin los números) y edita con mode after/before/replace.",
    "2. Haz los cambios con edit-file (varios bloques = varias ediciones, en orden).",
    "3. Pasa check-syntax al terminar de editar.",
    "4. ANTES de terminar, verifica que cumpliste la petición COMPLETA (si pide variable + comandos, toca schema.yml Y plugin.js; no vale editar solo un log).",
    "5. Termina con show-diff y un resumen de 1-3 líneas.",
    "6. Si edit-file devuelve ERROR, no repitas esa edición: lee de nuevo el archivo con read-file, elige un ancla actual y vuelve a formular el cambio. Corrige otros errores con un máximo de 2 reintentos; si sigues bloqueado, explica qué falta.",
    "7. No repitas llamadas idénticas. Después de recibir un resultado, úsalo para elegir una acción distinta; un error nunca cuenta como éxito.",
    "8. Antes de una tool puedes escribir una frase breve indicando la acción. No expongas razonamiento privado; limita el texto visible al plan y al resumen.",
    "9. Si detectas que ibas a emitir el plugin.js completo como respuesta, detente. En su lugar usa read-file para ver el archivo, edit-file para modificarlo, y show-diff para terminar.",
    "10. Si solo explicas (sin tocar código), responde prosa SIN bloques tool.",
    "",
    "== DOCS plugin-api.md ==",
    trunc(markdown, b.docs),
    "",
    "== plugin-api.d.ts (resumen) ==",
    trunc(dts, b.dts),
  ].join("\n");
}

/** Mensaje user inicial del modo agente (contexto del plugin). */
export function buildAgentUserPrompt(input: FixInput, customInstruction?: string, b: PromptBudgets = budgetsFor(4096)): string {
  const parts = [
    `Plugin: ${input.pluginName ?? "(sin nombre)"}`,
    customInstruction?.trim()
      ? `Petición: ${customInstruction.trim()}`
      : "Petición: revisa el plugin y propone mejoras o fixes.",
  ];
  if (input.lastError?.trim()) {
    parts.push(`Último error:\n${trunc(input.lastError.trim(), b.error)}`);
  }
  parts.push(
    "Los archivos plugin.js, schema.yml y config.toml están disponibles con read-file. Lee solo el que necesites antes de editar; no vuelques su contenido en la respuesta.",
  );
  parts.push("⚠ No copies el contenido de estos archivos en la respuesta. Usa las herramientas.");
  return parts.join("\n\n");
}
