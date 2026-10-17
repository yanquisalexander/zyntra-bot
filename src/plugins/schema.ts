import { z } from "zod";
import YAML from "yaml";

/**
 * schema.yml — declara los ajustes de un plugin (opcional).
 *
 * - Solo se edita como archivo; el panel lo usa para pintar el formulario.
 * - Categoría y descripción son solo metadata para la UI: no afectan al runtime.
 * - Los valores viven en config.toml; `api.config` no cambia.
 */

const fieldSchema = z
  .object({
    key: z
      .string()
      .min(1, "key vacío")
      .max(64)
      .regex(/^[A-Za-z0-9_]+$/, "key solo [A-Za-z0-9_]"),
    type: z.enum(["string", "text", "number", "boolean", "select", "role", "role_list", "variable", "secret"]),
    label: z.string().max(80).optional(),
    description: z.string().max(300).optional(),
    category: z.string().max(40).optional().default("General"),
    default: z.unknown().optional(),
    options: z.array(z.string().max(40)).max(20).optional(),
    required: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** Solo para type: variable — tipo del valor persistente. */
    varType: z.enum(["number", "string", "boolean"]).optional(),
    /** No se muestra en el panel (ajuste interno). Se guarda y valida igual. */
    hidden: z.boolean().optional(),
  })
  .refine((f) => f.type !== "select" || (f.options && f.options.length > 0), {
    message: "select necesita options no vacío",
  })
  .refine((f) => f.type !== "variable" || !!f.varType, {
    message: "variable necesita varType (number | string | boolean)",
  });

const schemaFileSchema = z.object({
  version: z.literal(1).optional(),
  categories: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        description: z.string().max(200).optional(),
      }),
    )
    .max(20)
    .optional()
    .default([]),
  fields: z.array(fieldSchema).max(60).default([]),
});

export type SchemaField = z.infer<typeof fieldSchema> & { category: string };
export interface SchemaCategory {
  name: string;
  description?: string;
}
export interface PluginSchema {
  categories: SchemaCategory[];
  fields: SchemaField[];
}

function zodError(prefix: string, error: z.ZodError): string {
  const i = error.issues[0];
  const at = i.path.length > 0 ? ` (${String(i.path.join("."))})` : "";
  return `${prefix}${at}: ${i.message}`;
}

/** Valida el texto de schema.yml. Vacío = sin esquema (válido, no hay formulario). */
export function parseSchemaYaml(raw: string): { ok: true; schema: PluginSchema | null } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true, schema: null };
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (e) {
    return { ok: false, error: `YAML inválido: ${String(e instanceof Error ? e.message.split("\n")[0] : e)}` };
  }
  if (typeof doc !== "object" || doc === null) {
    return { ok: false, error: "schema.yml debe ser un objeto con `fields:`" };
  }
  const parsed = schemaFileSchema.safeParse(doc);
  if (!parsed.success) return { ok: false, error: zodError("schema.yml inválido", parsed.error) };
  const seen = new Set<string>();
  for (const f of parsed.data.fields) {
    if (seen.has(f.key)) return { ok: false, error: `schema.yml inválido: key duplicada "${f.key}"` };
    seen.add(f.key);
  }
  return {
    ok: true,
    schema: {
      categories: parsed.data.categories ?? [],
      fields: parsed.data.fields as SchemaField[],
    },
  };
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "";

/** IDs de Discord (roles, canales…): 17-20 dígitos. */
const isSnowflake = (v: unknown): v is string => typeof v === "string" && /^\d{17,20}$/.test(v);

/**
 * Valida valores del formulario contra el esquema y los fusiona con la
 * config existente. Las claves desconocidas del payload se ignoran
 * (la config puede tener claves fuera del esquema).
 *
 * Los campos `type: variable` NO van al TOML: se devuelven aparte en
 * `varValues` para guardarlos en el store de variables.
 */
export function validateSettings(
  schema: PluginSchema,
  values: Record<string, unknown>,
  existing: Record<string, unknown>,
):
  | { ok: true; merged: Record<string, unknown>; varValues: Record<string, import("./types.js").VarValue> }
  | { ok: false; error: string } {
  const validated: Record<string, unknown> = {};
  const varValues: Record<string, import("./types.js").VarValue> = {};
  for (const f of schema.fields) {
    if (!(f.key in values)) continue;
    if (f.type === "variable") {
      const vv = values[f.key];
      if (vv === undefined) continue;
      if (typeof vv !== "string" && typeof vv !== "number" && typeof vv !== "boolean") {
        return { ok: false, error: `"${f.key}": valor inválido` };
      }
      if (f.varType === "number" && (typeof vv !== "number" || !Number.isFinite(vv))) {
        return { ok: false, error: `"${f.key}": tiene que ser un número` };
      }
      if (f.varType === "string" && typeof vv !== "string") {
        return { ok: false, error: `"${f.key}": tiene que ser texto` };
      }
      if (f.varType === "boolean" && typeof vv !== "boolean") {
        return { ok: false, error: `"${f.key}": tiene que ser sí/no` };
      }
      if (f.required && (vv === "" || vv === null)) {
        return { ok: false, error: `"${f.key}": es obligatorio` };
      }
      varValues[f.key] = vv;
      continue;
    }
    const v = values[f.key];
    switch (f.type) {
      case "string":
      case "text":
      case "secret": {
        // secret = texto que en el panel sale enmascarado (vive en config.toml como string).
        if (typeof v !== "string") return { ok: false, error: `"${f.key}": tiene que ser texto` };
        if (f.required && v.trim() === "") return { ok: false, error: `"${f.key}": es obligatorio` };
        validated[f.key] = v;
        break;
      }
      case "number": {
        if (isEmpty(v)) {
          if (f.required) return { ok: false, error: `"${f.key}": es obligatorio` };
          break; // vacío no obligatorio: se conserva el valor actual
        }
        const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
        if (!Number.isFinite(n)) return { ok: false, error: `"${f.key}": tiene que ser un número` };
        if (f.min !== undefined && n < f.min) return { ok: false, error: `"${f.key}": mínimo ${f.min}` };
        if (f.max !== undefined && n > f.max) return { ok: false, error: `"${f.key}": máximo ${f.max}` };
        validated[f.key] = n;
        break;
      }
      case "boolean": {
        if (typeof v === "boolean") validated[f.key] = v;
        else if (v === "true") validated[f.key] = true;
        else if (v === "false") validated[f.key] = false;
        else return { ok: false, error: `"${f.key}": tiene que ser sí/no` };
        break;
      }
      case "select": {
        if (typeof v !== "string" || !(f.options ?? []).includes(v)) {
          return { ok: false, error: `"${f.key}": elige entre ${(f.options ?? []).join(", ")}` };
        }
        validated[f.key] = v;
        break;
      }
      case "role": {
        // Un ID de rol (string). Vacío = sin rol (vale si no es obligatorio).
        if (isEmpty(v)) {
          if (f.required) return { ok: false, error: `"${f.key}": es obligatorio` };
          validated[f.key] = "";
          break;
        }
        if (!isSnowflake(v)) return { ok: false, error: `"${f.key}": elige un rol válido` };
        validated[f.key] = v;
        break;
      }
      case "role_list": {
        // Varios IDs de rol (array TOML). Vacío = ninguno (vale si no es obligatorio).
        const arr = Array.isArray(v) ? v : isEmpty(v) ? [] : null;
        if (arr === null) return { ok: false, error: `"${f.key}": tiene que ser una lista de roles` };
        const clean = [...new Set(arr.filter((x) => typeof x === "string" && x !== ""))];
        if (clean.some((x) => !isSnowflake(x))) {
          return { ok: false, error: `"${f.key}": tiene un rol inválido` };
        }
        if (f.required && clean.length === 0) return { ok: false, error: `"${f.key}": elige al menos un rol` };
        validated[f.key] = clean;
        break;
      }
    }
  }
  const merged = { ...existing, ...validated };
  for (const f of schema.fields) {
    if (!f.required) continue;
    if (f.type === "variable") {
      // Obligatorio cubierto si viene valor o hay default en el schema.
      if (f.key in varValues || f.default !== undefined) continue;
      return { ok: false, error: `"${f.key}": es obligatorio` };
    }
    const mv = merged[f.key];
    if (isEmpty(mv) || (f.type === "role_list" && Array.isArray(mv) && mv.length === 0)) {
      return { ok: false, error: `"${f.key}": es obligatorio` };
    }
  }
  return { ok: true, merged, varValues };
}

function prettyLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function inferType(v: unknown): "string" | "text" | "number" | "boolean" | null {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number" && Number.isFinite(v)) return "number";
  if (typeof v === "string") return v.includes("\n") ? "text" : "string";
  return null;
}

/** Genera un schema.yml inicial desde la config.toml actual (solo escalares). */
export function generateSchemaYaml(existing: Record<string, unknown>): string {
  const fields = Object.entries(existing)
    .map(([key, v]) => {
      if (!/^[A-Za-z0-9_]+$/.test(key)) return null;
      const type = inferType(v);
      if (!type) return null;
      return { key, type, label: prettyLabel(key), category: "General", default: v };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);
  return YAML.stringify({
    version: 1,
    categories: [],
    fields,
  });
}

export const SCHEMA_STARTER_COMMENT = `# Ajustes del plugin — declara aquí los campos del formulario.
# Solo se edita como archivo: categoría y descripción son solo ayuda visual.
# Los valores viven en config.toml; type: string | text | number | boolean | select | role | role_list | variable | secret.
# role = un rol del servidor (picker), role_list = varios roles (multi-picker).
# variable = dato persistente del bot (api.vars) con varType: number | string | boolean.
# secret = texto enmascarado en el panel (para claves y tokens).
# hidden: true = no se muestra en el panel (internos), pero se guarda igual.
`;
