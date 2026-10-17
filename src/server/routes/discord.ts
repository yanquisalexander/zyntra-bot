import { Hono } from "hono";
import { requireAdmin } from "../session.js";
import { getClient } from "../../bot/client.js";
import { readBotConfig } from "./config.js";

/**
 * Datos del servidor para el panel (picker de servidor, tipos `role` / `role_list`).
 * Single server: todo se resuelve contra el `guildId` configurado
 * (fallback al primero donde está el bot si aún no hay).
 */
export function discordRoutes(): Hono {
  const r = new Hono();
  r.use("*", requireAdmin);

  /** Servidores donde está el bot (para elegir el servidor único). */
  r.get("/guilds", (c) => {
    const client = getClient();
    if (!client.isReady()) {
      return c.json({ error: "bot desconectado: conecta desde el Dashboard" }, 503);
    }
    const guilds = [...client.guilds.cache.values()].map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.iconURL() ?? null,
      memberCount: g.memberCount,
    }));
    return c.json({ guilds });
  });

  /** Roles del servidor configurado (para los pickers de ajustes). */
  r.get("/roles", async (c) => {
    const client = getClient();
    if (!client.isReady()) {
      return c.json({ error: "bot desconectado: conecta desde el Dashboard" }, 503);
    }
    const guild = await resolveGuild(client);
    if (!guild) {
      return c.json({ error: "el bot no está en ningún servidor" }, 404);
    }
    try {
      const roles = await guild.roles.fetch();
      const list = [...roles.values()]
        .map((role) => ({
          id: role.id,
          name: role.name,
          color: role.hexColor,
          position: role.position,
          managed: role.managed,
        }))
        .sort((a, b) => b.position - a.position);
      return c.json({ guild: { id: guild.id, name: guild.name }, roles: list });
    } catch (e) {
      return c.json({ error: `no se pudieron leer los roles: ${String(e)}` }, 500);
    }
  });

  return r;
}

async function resolveGuild(client: ReturnType<typeof getClient>) {
  if (client.guilds.cache.size === 0) return null;
  try {
    const cfg = await readBotConfig();
    const id = typeof cfg.guildId === "string" ? cfg.guildId : "";
    if (id && client.guilds.cache.has(id)) {
      return client.guilds.cache.get(id)!;
    }
  } catch {
    /* sin config: primero disponible */
  }
  return client.guilds.cache.first() ?? null;
}
