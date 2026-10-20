import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionUser, requireAdmin } from "../session.js";
import { env } from "../env.js";
import { eq } from "drizzle-orm";

const DEFAULTS = {
  prefix: "!",
  systemChannelId: "",
  guildId: "",
  aiCompanionEnabled: false,
  aiCompanionModel: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
};

/** Prefix para snowflakes de Discord en jsonb: evita que pg los lea como
 * número y pierda precisión sobre Number.MAX_SAFE_INTEGER. El resto del
 * código siempre ve el ID puro sin prefix. */
const GUILD_ID_PREFIX = "g";

function encodeGuildId(value: unknown): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s.startsWith(GUILD_ID_PREFIX) ? s : `${GUILD_ID_PREFIX}${s}`;
}

function decodeGuildId(value: unknown): string {
  if (typeof value === "string") {
    return value.startsWith(GUILD_ID_PREFIX) ? value.slice(1) : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Valor legacy corrupto por precisión: mejor devolverlo como string
    // aunque ya esté dañado; el frontend lo mostrará y el usuario podrá
    // volver a elegir el servidor correcto.
    return String(value);
  }
  return "";
}

/** Lee la config del bot (DB; sin DB devuelve defaults). */
export async function readBotConfig(): Promise<Record<string, unknown>> {
  return readAll();
}

async function readAll(): Promise<Record<string, unknown>> {
  try {
    const { getDb } = await import("../../db/client.js");
    const { botConfig } = await import("../../db/schema.js");
    const rows = await getDb().select().from(botConfig);
    const out: Record<string, unknown> = { ...DEFAULTS };
    for (const r of rows as { key: string; value: unknown }[]) {
      let value = r.value;
      if (r.key === "guildId") {
        value = decodeGuildId(value);
      }
      out[r.key] = value;
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export function configRoutes(onPrefix?: (p: string) => void, onGuildId?: (g: string) => void): Hono {
  const r = new Hono();
  r.use("*", requireAdmin);
  r.get("/", async (c) => c.json({ config: await readAll(), bypassAdminServerCheck: env.BYPASS_ADMIN_SERVER_CHECK, secretsConfigured: { token: !!process.env.DISCORD_TOKEN } }));
  r.put("/", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    // Nunca aceptar secretos por esta ruta.
    const { DISCORD_TOKEN, CLIENT_SECRET, SESSION_SECRET, ...safe } = body as Record<string, unknown>;
    void DISCORD_TOKEN;
    void CLIENT_SECRET;
    void SESSION_SECRET;
    // Discord snowflakes deben viajar como texto. Si llega como número (JSON
    // sin comillas), JavaScript pierde precisión sobre MAX_SAFE_INTEGER y el
    // ID se corrompe. Forzamos string antes de escribir en jsonb.
    if (Object.hasOwn(safe, "guildId") && typeof safe.guildId !== "string") {
      return c.json({ error: "guildId debe enviarse como texto; los IDs de Discord no son números" }, 400);
    }
    // El servidor elegido: el bot tiene que estar dentro y el usuario ser
    // admin de ese servidor (en local se omite el check de admin).
    if (typeof safe.guildId === "string" && safe.guildId !== "") {
      const err = await validateGuildAccess(c, safe.guildId);
      if (err) return c.json({ error: err.message }, err.status);
    }
    try {
      const { getDb } = await import("../../db/client.js");
      const { botConfig } = await import("../../db/schema.js");
      const { eq } = await import("drizzle-orm");
      const db = getDb();
      for (const [key, value] of Object.entries(safe)) {
        const ex = await db.select().from(botConfig).where(eq(botConfig.key, key)).limit(1);
        // guildId es un snowflake de Discord: puede superar
        // Number.MAX_SAFE_INTEGER. Guardamos con prefix "g" para que Postgres
        // lo almacene como string JSON ("g700185692826763264") y nunca como
        // número (700185692826763300), que pg devolvería como number JS
        // perdiendo precisión. El resto del código recibe el ID puro.
        const stored = key === "guildId" && typeof value === "string" ? encodeGuildId(value) : value;
        if (ex.length === 0) {
          await db.insert(botConfig).values({ key, stored } as never);
        } else {
          await db.update(botConfig).set({ value: stored } as never).where(eq(botConfig.key, key));
        }
      }
      if (typeof safe.prefix === "string") onPrefix?.(safe.prefix);
      if (typeof safe.guildId === "string") onGuildId?.(safe.guildId);
      return c.json({ ok: true, config: await readAll() });
    } catch (e) {
      return c.json({ error: `DB no disponible: ${String(e)}` }, 500);
    }
  });
  return r;
}

/**
 * Valida el servidor único: formato, bot dentro y usuario admin del servidor.
 * En local (`NODE_ENV !== "production"`) se omite el check de admin.
 * Con `BYPASS_ADMIN_SERVER_CHECK=true` también se omite (modo compartido:
 * cualquier admin del panel puede configurar el bot para servidores
 * donde no es admin).
 */
async function validateGuildAccess(
  c: Context,
  guildId: string,
): Promise<{ message: string; status: 400 | 403 } | null> {
  if (!/^\d{17,20}$/.test(guildId)) return { message: "servidor inválido", status: 400 };
  const { getClient } = await import("../../bot/client.js");
  const client = getClient();
  if (!client.isReady()) return { message: "conecta el bot primero para elegir servidor", status: 400 };
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { message: "el bot no está en ese servidor", status: 400 };
  if (env.BYPASS_ADMIN_SERVER_CHECK) return null;
  if (process.env.NODE_ENV !== "production") return null;
  try {
    const user = await getSessionUser(c);
    if (!user) return { message: "unauthorized", status: 403 };
    const member = await guild.members.fetch(user.discordId);
    const { PermissionsBitField } = await import("discord.js");
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return { message: "no eres admin de ese servidor", status: 403 };
    }
  } catch {
    return { message: "no se pudo comprobar si eres admin de ese servidor", status: 403 };
  }
  return null;
}
