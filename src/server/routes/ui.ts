import { Hono } from "hono";
import { requireAdmin } from "../session.js";
import { logger } from "../../plugins/logger.js";
import type { PluginManager } from "../../plugins/manager.js";

const ACTION_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 10 * 1024;

/** Pestañas para la sección del sidebar. Solo plugins activos. */
export function listUiTabs(manager: PluginManager) {
  const meta = new Map(manager.list().map((p) => [p.name, p]));
  return manager.ui
    .listTabs()
    .filter((t) => meta.get(t.plugin)?.status === "active")
    .map((t) => ({ ...t, displayName: meta.get(t.plugin)?.displayName ?? t.plugin }));
}

export function uiRoutes(manager: PluginManager): Hono {
  const r = new Hono();
  r.use("*", requireAdmin);

  r.get("/tabs", (c) => {
    return c.json({ tabs: listUiTabs(manager) });
  });

  /** Un tab resuelto (widgets con datos). Nunca lanza: provider roto = widget en error. */
  r.get("/tab/:plugin/:tab", async (c) => {
    const plugin = c.req.param("plugin");
    const tab = decodeURIComponent(c.req.param("tab"));
    const meta = manager.list().find((p) => p.name === plugin);
    if (!meta || meta.status !== "active") {
      return c.json({ error: "plugin no activo" }, 404);
    }
    const view = await manager.ui.resolveTab(plugin, tab);
    if (!view) return c.json({ error: "vista no encontrada" }, 404);
    return c.json({ ...view, displayName: meta.displayName });
  });

  /** Ejecuta una acción de un widget `actions`. Devuelve mensaje para el toast. */
  r.post("/:plugin/action/:actionId", async (c) => {
    const plugin = c.req.param("plugin");
    const actionId = decodeURIComponent(c.req.param("actionId"));
    const meta = manager.list().find((p) => p.name === plugin);
    if (!meta || meta.status !== "active") {
      return c.json({ error: "plugin no activo" }, 404);
    }
    const action = manager.ui.getAction(plugin, actionId);
    if (!action) return c.json({ error: "acción no encontrada" }, 404);
    let args: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) {
        if (raw.length > MAX_BODY_BYTES) return c.json({ error: "body demasiado grande" }, 413);
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      }
    } catch {
      return c.json({ error: "body JSON inválido" }, 400);
    }
    try {
      const message = await Promise.race([
        action.handler(args),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`timeout (${ACTION_TIMEOUT_MS}ms)`)), ACTION_TIMEOUT_MS),
        ),
      ]);
      logger.info(`plugin:${plugin}`, `ui action "${actionId}" OK`);
      return c.json({
        ok: true,
        message: typeof message === "string" && message ? message.slice(0, 200) : null,
      });
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 300);
      logger.error(`plugin:${plugin}`, `ui action "${actionId}": ${msg}`);
      return c.json({ error: msg }, 409);
    }
  });

  return r;
}
