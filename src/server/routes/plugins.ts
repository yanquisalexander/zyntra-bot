import { Hono } from "hono";
import type { Context } from "hono";
import { requireAdmin } from "../session.js";
import type { PluginManager } from "../../plugins/manager.js";
import {
  createPlugin,
  DEFAULT_PLUGIN_CODE,
  deletePlugin,
  isCore,
  listPluginNames,
  PLUGIN_TEMPLATES,
  readCode,
  readConfigToml,
  readSchema,
  snapshotConfigRevision,
  writeCode,
  writeConfig,
  writeSchema,
} from "../../plugins/store.js";
import { syntaxCheck } from "../../plugins/loader.js";
import { parseConfig } from "../../plugins/store.js";
import {
  generateSchemaYaml,
  parseSchemaYaml,
  validateSettings,
} from "../../plugins/schema.js";
import { stringify as stringifyToml } from "smol-toml";
import { getSessionUser } from "../session.js";

export function pluginsRoutes(manager: PluginManager): Hono {
  const r = new Hono();
  r.use("*", requireAdmin);

  /** Core: solo ajustes, variables y on/off. Nada de código, schema, config cruda ni borrado. */
  const coreGuard = async (c: Context) => {
    // Context genérico (sin inferencia de ruta): el param puede venir undefined.
    if (await isCore(c.req.param("name") ?? "")) {
      return c.json({ error: "plugin core: no editable (solo ajustes y activar/desactivar)" }, 403);
    }
    return null;
  };

  r.get("/", (c) => c.json({ plugins: manager.list(), prefix: manager.prefix }));

  r.post("/", async (c) => {
    const body = await c.req.json<{ name?: string; displayName?: string; template?: string }>();
    const name = (body.name ?? "").toLowerCase().trim();
    if (!name) return c.json({ error: "id requerido" }, 400);
    const template = body.template && body.template in PLUGIN_TEMPLATES
      ? (body.template as keyof typeof PLUGIN_TEMPLATES)
      : "hola";
    // Nombre visible: si no viene, se usa el id (antes se metía el id en el código).
    const displayName = (body.displayName ?? "").trim() || name;
    try {
      const tpl = PLUGIN_TEMPLATES[template];
      await createPlugin(name, tpl.code(displayName), tpl.config, tpl.schema);
      await manager.enable(name).catch(() => undefined);
      return c.json({ ok: true, plugin: manager.getStatus(name) });
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e) }, 400);
    }
  });

  r.get("/:name", async (c) => {
    const name = c.req.param("name");
    try {
      const [code, config, schemaRaw] = await Promise.all([
        readCode(name),
        readConfigToml(name),
        readSchema(name),
      ]);
      let configJson: Record<string, unknown> = {};
      try {
        configJson = parseConfig(config);
      } catch {
        configJson = {};
      }
      const parsed = parseSchemaYaml(schemaRaw);
      const { readVarsFile } = await import("../../plugins/vars.js");
      return c.json({
        ...manager.getStatus(name),
        code,
        config,
        configJson,
        schemaRaw,
        schema: parsed.ok ? parsed.schema : null,
        schemaError: parsed.ok ? null : parsed.error,
        vars: await readVarsFile(name),
        detail: manager.list().find((p) => p.name === name),
      });
    } catch {
      return c.json({ error: "plugin no encontrado" }, 404);
    }
  });

  r.put("/:name/code", async (c) => {
    const blocked = await coreGuard(c);
    if (blocked) return blocked;
    const name = c.req.param("name");
    const { code } = await c.req.json<{ code?: string }>();
    if (typeof code !== "string") return c.json({ error: "code requerido" }, 400);
    try {
      await writeCode(name, code);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  r.put("/:name/config", async (c) => {
    const blocked = await coreGuard(c);
    if (blocked) return blocked;
    const name = c.req.param("name");
    const { toml } = await c.req.json<{ toml?: string }>();
    if (typeof toml !== "string") return c.json({ error: "toml requerido" }, 400);
    try {
      parseConfig(toml); // validación con error comprensible
      await writeConfig(name, toml);
      // Snapshot de revisión (rollback futuro).
      try {
        const user = await getSessionUser(c);
        const { getDb } = await import("../../db/client.js");
        const { pluginConfigRevisions, users } = await import("../../db/schema.js");
        const { eq } = await import("drizzle-orm");
        const db = getDb();
        let createdBy: string | null = null;
        if (user) {
          const rows = await db.select().from(users).where(eq(users.discordId, user.discordId)).limit(1);
          createdBy = rows[0]?.id ?? null;
        }
        await db.insert(pluginConfigRevisions).values({ pluginName: name, toml, createdBy } as never);
      } catch {
        /* DB opcional */
      }
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: `TOML inválido: ${String(e)}` }, 400);
    }
  });

  // Guarda schema.yml (validado). Vacío = sin formulario.
  r.put("/:name/schema", async (c) => {
    const blocked = await coreGuard(c);
    if (blocked) return blocked;
    const name = c.req.param("name");
    const { raw } = await c.req.json<{ raw?: string }>();
    if (typeof raw !== "string") return c.json({ error: "raw requerido" }, 400);
    try {
      const schema = await writeSchema(name, raw);
      return c.json({ ok: true, schema });
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e).slice(0, 500) }, 400);
    }
  });

  // Genera un schema.yml inicial desde la config.toml actual (solo si no hay).
  r.post("/:name/schema/generate", async (c) => {
    const blocked = await coreGuard(c);
    if (blocked) return blocked;
    const name = c.req.param("name");
    try {
      const existing = await readSchema(name);
      if (existing.trim()) return c.json({ error: "ya existe schema.yml: edítalo como archivo" }, 400);
      const toml = await readConfigToml(name);
      const config = parseConfig(toml);
      const raw = generateSchemaYaml(config);
      const schema = await writeSchema(name, raw);
      return c.json({ ok: true, schema, schemaRaw: raw });
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e).slice(0, 500) }, 400);
    }
  });

  // Guarda valores del formulario: valida contra el esquema y fusiona con config.toml.
  r.put("/:name/settings", async (c) => {
    const name = c.req.param("name");
    const { values } = await c.req.json<{ values?: Record<string, unknown> }>();
    if (!values || typeof values !== "object") return c.json({ error: "values requerido" }, 400);
    try {
      const schemaRaw = await readSchema(name);
      const parsed = parseSchemaYaml(schemaRaw);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      if (!parsed.schema) return c.json({ error: "este plugin no tiene schema.yml" }, 400);
      let existing: Record<string, unknown> = {};
      try {
        existing = parseConfig(await readConfigToml(name));
      } catch {
        existing = {};
      }
      const checked = validateSettings(parsed.schema, values, existing);
      if (!checked.ok) return c.json({ error: checked.error }, 400);
      const toml = stringifyToml(checked.merged);
      await writeConfig(name, toml);
      // Los campos variable van al store de vars (no al TOML: no recargan).
      const { varsSet, readVarsFile, varDefsFromSchema } = await import("../../plugins/vars.js");
      const varDefs = varDefsFromSchema(parsed.schema);
      for (const [key, value] of Object.entries(checked.varValues)) {
        try {
          await varsSet(name, varDefs, key, value);
        } catch (e) {
          return c.json({ error: String(e instanceof Error ? e.message : e) }, 400);
        }
      }
      const user = await getSessionUser(c).catch(() => null);
      await snapshotConfigRevision(name, toml, user?.discordId ?? null);
      return c.json({ ok: true, vars: await readVarsFile(name) });
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e).slice(0, 500) }, 400);
    }
  });

  // Variables del plugin (store vars.json, no dispara recarga).
  r.get("/:name/variables", async (c) => {
    const name = c.req.param("name");
    const { readVarsFile, varDefsFromSchema } = await import("../../plugins/vars.js");
    const parsed = parseSchemaYaml(await readSchema(name));
    const declared = parsed.ok && parsed.schema
      ? [...(varDefsFromSchema(parsed.schema)?.keys() ?? [])]
      : [];
    return c.json({ vars: await readVarsFile(name), declared });
  });

  r.put("/:name/variables", async (c) => {
    const name = c.req.param("name");
    const { values } = await c.req.json<{ values?: Record<string, unknown> }>();
    if (!values || typeof values !== "object") return c.json({ error: "values requerido" }, 400);
    try {
      const { varsSet, readVarsFile, varDefsFromSchema } = await import("../../plugins/vars.js");
      const parsed = parseSchemaYaml(await readSchema(name));
      if (!parsed.ok || !parsed.schema) return c.json({ error: "este plugin no declara variables (schema.yml)" }, 400);
      const varDefs = varDefsFromSchema(parsed.schema);
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          return c.json({ error: `"${key}": valor inválido` }, 400);
        }
        await varsSet(name, varDefs, key, value);
      }
      return c.json({ ok: true, vars: await readVarsFile(name) });
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e).slice(0, 500) }, 400);
    }
  });

  r.delete("/:name/variables/:key", async (c) => {
    const name = c.req.param("name");
    const key = c.req.param("key");
    try {
      const { varsReset, readVarsFile, varDefsFromSchema } = await import("../../plugins/vars.js");
      const parsed = parseSchemaYaml(await readSchema(name));
      if (!parsed.ok || !parsed.schema) return c.json({ error: "este plugin no declara variables (schema.yml)" }, 400);
      const resetTo = await varsReset(name, varDefsFromSchema(parsed.schema), key);
      return c.json({ ok: true, resetTo: resetTo ?? null, vars: await readVarsFile(name) });
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e).slice(0, 500) }, 400);
    }
  });

  r.post("/:name/validate", async (c) => {
    const name = c.req.param("name");
    const check = await syntaxCheck(name);
    return c.json(check);
  });

  r.post("/:name/reload", async (c) => {
    const name = c.req.param("name");
    try {
      await manager.reload(name);
      return c.json({ ok: true, plugin: manager.getStatus(name) });
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 1000), plugin: manager.getStatus(name) }, 500);
    }
  });

  r.post("/:name/enable", async (c) => {
    try {
      await manager.enable(c.req.param("name"));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 1000) }, 500);
    }
  });

  r.post("/:name/disable", async (c) => {
    await manager.disable(c.req.param("name"));
    return c.json({ ok: true });
  });

  r.delete("/:name", async (c) => {
    const blocked = await coreGuard(c);
    if (blocked) return blocked;
    const name = c.req.param("name");
    await manager.unload(name).catch(() => undefined);
    await deletePlugin(name);
    try {
      const { getDb } = await import("../../db/client.js");
      const { plugins } = await import("../../db/schema.js");
      const { eq } = await import("drizzle-orm");
      await getDb().delete(plugins).where(eq(plugins.name, name));
    } catch {
      /* noop */
    }
    manager.forget(name);
    return c.json({ ok: true });
  });

  r.get("/_debug/names", async (c) => c.json({ names: await listPluginNames() }));

  return r;
}
