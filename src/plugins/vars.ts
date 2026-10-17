import fs from "node:fs/promises";
import path from "node:path";
import { pluginDir } from "./store.js";

/**
 * Variables por plugin: clave/valor persistente entre comandos y reinicios.
 *
 * - Vive en `data/plugins/<id>/vars.json` (NO en config.toml: así no dispara
 *   el watcher de recarga en cada `!contador`).
 * - Solo claves declaradas en schema.yml (`type: variable`): lo no declarado falla.
 * - Caché en memoria + write-through con cadena de promesas por plugin para
 *   que `incr` concurrente no pierda incrementos.
 */

export type VarValue = number | string | boolean;
export type VarTypeName = "number" | "string" | "boolean";

export interface VarDef {
  key: string;
  varType: VarTypeName;
  default?: VarValue;
}

const KEY_RE = /^[A-Za-z0-9_]{1,64}$/;
const MAX_KEYS = 100;
const MAX_VALUE_BYTES = 10 * 1024;
const MAX_FILE_BYTES = 100 * 1024;

const cache = new Map<string, Record<string, VarValue>>();
const chains = new Map<string, Promise<unknown>>();

/** Mutex por plugin: encadena operaciones para lecturas-modificaciones atómicas. */
function chain<T>(plugin: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(plugin) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(plugin, next.catch(() => undefined));
  return next as Promise<T>;
}

function varsPath(plugin: string): string {
  return path.join(pluginDir(plugin), "vars.json");
}

function sanitize(raw: unknown): Record<string, VarValue> {
  const out: Record<string, VarValue> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY_RE.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, MAX_VALUE_BYTES);
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

async function loadLocked(plugin: string): Promise<Record<string, VarValue>> {
  const hit = cache.get(plugin);
  if (hit) return hit;
  let data: Record<string, VarValue> = {};
  try {
    const raw = await fs.readFile(varsPath(plugin), "utf8");
    if (raw.trim()) data = sanitize(JSON.parse(raw));
  } catch {
    data = {};
  }
  cache.set(plugin, data);
  return data;
}

async function saveLocked(plugin: string, data: Record<string, VarValue>): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  if (text.length > MAX_FILE_BYTES) throw new Error("variables: límite de tamaño excedido");
  await fs.mkdir(pluginDir(plugin), { recursive: true });
  await fs.writeFile(varsPath(plugin), text, "utf8");
  cache.set(plugin, data);
}

export function isVarValue(v: unknown): v is VarValue {
  return (
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v))
  );
}

/** Construye el mapa de variables declaradas desde un schema parseado. */
export function varDefsFromSchema(schema: {
  fields: { key: string; type: string; varType?: string; default?: unknown }[];
} | null): Map<string, VarDef> | null {
  if (!schema) return null;
  const defs = new Map<string, VarDef>();
  for (const f of schema.fields) {
    if (f.type !== "variable") continue;
    if (f.varType !== "number" && f.varType !== "string" && f.varType !== "boolean") continue;
    defs.set(f.key, {
      key: f.key,
      varType: f.varType,
      default: isVarValue(f.default) ? f.default : undefined,
    });
  }
  return defs;
}

/** Resuelve la definición o lanza si no hay schema / no está declarada. */
export function declaredOrThrow(
  declared: Map<string, VarDef> | null,
  plugin: string,
  key: string,
): VarDef {
  void plugin;
  if (!KEY_RE.test(key)) throw new Error(`variable inválida: "${key}" (a-z, 0-9, _)`);
  if (!declared) throw new Error("este plugin no declara variables (añade type: variable en schema.yml)");
  const def = declared.get(key);
  if (!def) throw new Error(`variable "${key}" no declarada en schema.yml`);
  return def;
}

export function checkType(def: VarDef, value: unknown): string | null {
  if (typeof value !== def.varType) {
    return `variable "${def.key}": tiene que ser ${def.varType}`;
  }
  if (typeof value === "string" && value.length > MAX_VALUE_BYTES) {
    return `variable "${def.key}": texto demasiado largo`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return `variable "${def.key}": número inválido`;
  }
  return null;
}

export async function varsAll(
  plugin: string,
  declared: Map<string, VarDef> | null,
): Promise<Record<string, VarValue>> {
  return chain(plugin, async () => {
    const stored = await loadLocked(plugin);
    const out: Record<string, VarValue> = {};
    if (declared) {
      for (const [key, def] of declared) {
        if (key in stored) out[key] = stored[key];
        else if (def.default !== undefined) out[key] = def.default;
      }
    }
    return out;
  });
}

export async function varsGet(
  plugin: string,
  declared: Map<string, VarDef> | null,
  key: string,
  fallback?: VarValue,
): Promise<VarValue | undefined> {
  return chain(plugin, async () => {
    const def = declaredOrThrow(declared, plugin, key);
    const stored = await loadLocked(plugin);
    if (key in stored) return stored[key];
    if (def.default !== undefined) return def.default;
    return fallback;
  });
}

export async function varsHas(
  plugin: string,
  declared: Map<string, VarDef> | null,
  key: string,
): Promise<boolean> {
  return chain(plugin, async () => {
    declaredOrThrow(declared, plugin, key);
    const stored = await loadLocked(plugin);
    return key in stored;
  });
}

export async function varsSet(
  plugin: string,
  declared: Map<string, VarDef> | null,
  key: string,
  value: VarValue,
): Promise<void> {
  return chain(plugin, async () => {
    const def = declaredOrThrow(declared, plugin, key);
    const err = checkType(def, value);
    if (err) throw new Error(err);
    const stored = await loadLocked(plugin);
    if (!(key in stored) && Object.keys(stored).length >= MAX_KEYS) {
      throw new Error("variables: demasiadas claves (máx 100)");
    }
    await saveLocked(plugin, { ...stored, [key]: value });
  });
}

export async function varsIncr(
  plugin: string,
  declared: Map<string, VarDef> | null,
  key: string,
  by = 1,
): Promise<number> {
  return chain(plugin, async () => {
    const def = declaredOrThrow(declared, plugin, key);
    if (def.varType !== "number") throw new Error(`variable "${key}": incr solo vale para number`);
    if (typeof by !== "number" || !Number.isFinite(by)) throw new Error("incr: cantidad inválida");
    const stored = await loadLocked(plugin);
    const cur = key in stored ? stored[key] : (def.default ?? 0);
    if (typeof cur !== "number" || !Number.isFinite(cur)) {
      throw new Error(`variable "${key}": no es un número`);
    }
    const next = cur + by;
    await saveLocked(plugin, { ...stored, [key]: next });
    return next;
  });
}

export async function varsReset(
  plugin: string,
  declared: Map<string, VarDef> | null,
  key: string,
): Promise<VarValue | undefined> {
  return chain(plugin, async () => {
    const def = declaredOrThrow(declared, plugin, key);
    const stored = await loadLocked(plugin);
    if (!(key in stored)) return def.default;
    const { [key]: _dropped, ...rest } = stored;
    await saveLocked(plugin, rest);
    return def.default;
  });
}

/** Lee el fichero tal cual (para el panel). Nunca lanza. */
export async function readVarsFile(plugin: string): Promise<Record<string, VarValue>> {
  try {
    const raw = await fs.readFile(varsPath(plugin), "utf8");
    if (!raw.trim()) return {};
    return sanitize(JSON.parse(raw));
  } catch {
    return {};
  }
}
