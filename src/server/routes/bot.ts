import { Hono } from "hono";
import { requireAdmin } from "../session.js";
import { botInfo, connect, disconnect } from "../../bot/client.js";
import { env } from "../env.js";

export function botRoutes(): Hono {
  const r = new Hono();
  r.use("*", requireAdmin);

  r.get("/status", (c) => c.json({ ...botInfo(), hasToken: !!env.DISCORD_TOKEN }));
  r.post("/connect", async (c) => {
    try {
      const info = await connect(env.DISCORD_TOKEN);
      return c.json({ ok: true, ...info });
    } catch (e) {
      return c.json({ ok: false, error: String(e) }, 500);
    }
  });
  r.post("/disconnect", async (c) => {
    await disconnect();
    return c.json({ ok: true });
  });
  return r;
}
