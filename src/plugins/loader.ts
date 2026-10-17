import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { pluginDir } from "./store.js";
import { runWithPlugin } from "./consoleBridge.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/** Chequeo de sintaxis con node --check antes de importar. */
export async function syntaxCheck(name: string): Promise<{ ok: boolean; error?: string }> {
  const file = path.join(pluginDir(name), "plugin.js");
  try {
    await execFileAsync(process.execPath, ["--check", file]);
    return { ok: true };
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, error: err.stderr ?? err.message ?? "syntax error" };
  }
}

export function validateDefinition(def: unknown): string | null {
  if (typeof def !== "object" || def === null) return "definePlugin debe retornar un objeto";
  const d = def as Record<string, unknown>;
  if (d.name !== undefined && typeof d.name !== "string") return "plugin.name debe ser texto (nombre visible)";
  // `name` es opcional: es el nombre visible, el ID es la carpeta.
  if (typeof d.setup !== "function") return "plugin.setup(api) requerido";
  return null;
}

/** Import dinámico con cache-busting para hot reload. */
export async function importFresh(name: string): Promise<unknown> {
  const file = path.join(pluginDir(name), "plugin.js");
  const code = await fs.readFile(file, "utf8");
  // Define el contrato declarativo esperado por los plugins.
  let captured: unknown = null;
  const definePlugin = (def: unknown) => {
    captured = def;
    return def;
  };
  const g = globalThis as Record<string, unknown>;
  const prev = g.definePlugin;
  g.definePlugin = definePlugin;
  try {
    // Compila primero para errores de sintaxis claros (además de --check).
    new Function("definePlugin", "require", "module", "exports", code);
    const url = pathToFileURL(file).href + `?t=${Date.now()}`;
    // Best-effort: atribuye los console.* del top-level del plugin.
    await runWithPlugin(name, () => import(url));
  } finally {
    if (prev === undefined) delete g.definePlugin;
    else g.definePlugin = prev;
  }
  if (!captured) {
    // Fallback: el módulo puede exportar por defecto sin definePlugin global.
    try {
      const url2 = pathToFileURL(file).href + `?e=${Date.now()}`;
      const mod = (await runWithPlugin(name, () => import(url2))) as Record<string, unknown>;
      captured = mod.default ?? mod.plugin ?? null;
    } catch (e) {
      logger.warn(`plugin:${name}`, `fallback import failed: ${String(e)}`);
    }
  }
  return captured;
}
