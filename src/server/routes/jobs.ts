import { Hono } from "hono";
import { requireAdmin } from "../session.js";
import type { PluginManager } from "../../plugins/manager.js";

export function jobsRoutes(manager: PluginManager): Hono {
  const r = new Hono();
  r.use("*", requireAdmin);

  r.get("/", async (c) => {
    const [schedules, orphans] = await Promise.all([
      manager.scheduler.list(),
      manager.scheduler.orphans(),
    ]);
    return c.json({
      schedules,
      orphans,
      runs: manager.scheduler.recentRuns(100),
    });
  });

  r.post("/:id/run", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    try {
      const runId = manager.scheduler.runNow(id);
      return c.json({ ok: true, runId });
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      const code = msg.includes("no encontrada") ? 404 : 409;
      return c.json({ error: msg }, code as 404 | 409);
    }
  });

  r.post("/:id/pause", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!manager.scheduler.pause(id)) return c.json({ error: "no se puede pausar" }, 409);
    return c.json({ ok: true });
  });

  r.post("/:id/resume", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!manager.scheduler.resume(id)) return c.json({ error: "no se puede reanudar" }, 409);
    return c.json({ ok: true });
  });

  r.post("/:id/cancel", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (manager.scheduler.cancel(id)) return c.json({ ok: true });
    if (await manager.scheduler.cancelOrphan(id)) return c.json({ ok: true });
    return c.json({ error: "no se puede cancelar (solo one-shots pendientes)" }, 409);
  });

  return r;
}
