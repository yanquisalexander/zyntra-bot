import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getSessionUser } from "../session.js";
import { adminIds, env } from "../env.js";
import { logger } from "../../plugins/logger.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface SetupCheck {
  id: "token" | "admins" | "database" | "bot" | "guild";
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

/**
 * Wizard de primer setup (estilo requirements-check): lista de
 * comprobaciones con su fix. Solo exige sesión, NO admin — si
 * ADMIN_DISCORD_IDS está vacío nadie pasaría requireAdmin y el
 * checklist sería inalcanzable justo cuando más hace falta.
 * No filtra secretos: solo presencia/estado, nada de valores.
 */
/**
 * Admin o modo bootstrap (primer setup: aún no hay admins y cualquiera
 * con sesión de Discord puede completar la instalación). En cuanto
 * existe un admin, solo admins.
 */
async function requireSetupAccess(c: Context, next: Next) {
  const user = await getSessionUser(c).catch(() => null);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { isAdmin } = await import("../env.js");
  if (isAdmin(user.discordId) || adminIds.size === 0) {
    c.set("user", user);
    await next();
    return;
  }
  return c.json({ error: "forbidden" }, 403);
}

/** Escribe (o añade) una clave en el .env preservando el resto. */
export function setEnvKey(key: string, value: string): void {
  if (value.includes("\n")) throw new Error("valor inválido");
  const file = path.resolve(process.cwd(), ".env");
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    raw = "";
  }
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, "m").test(raw)) {
    raw = raw.replace(new RegExp(`^${key}=.*$`, "m"), line);
  } else if (raw === "") {
    raw = `${line}\n`;
  } else {
    raw = `${raw.endsWith("\n") ? raw : `${raw}\n`}${line}\n`;
  }
  fs.writeFileSync(file, raw, "utf8");
}

export function setupRoutes(): Hono {
  const r = new Hono();

  r.get("/checks", async (c) => {
    const user = await getSessionUser(c).catch(() => null);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const checks: SetupCheck[] = [];

    // 1. Token del bot (crítico: sin esto no hay conexión posible).
    if (env.DISCORD_TOKEN) {
      checks.push({ id: "token", label: "Token del bot", status: "ok", detail: "DISCORD_TOKEN configurado." });
    } else {
      checks.push({
        id: "token",
        label: "Token del bot",
        status: "fail",
        detail: "Falta DISCORD_TOKEN en el .env.",
        fix: "Portal de Discord → tu app → Bot → Reset Token. Pégalo como DISCORD_TOKEN=… en el .env y reinicia (se lee al arrancar).",
      });
    }

    // 2. Admins del panel (crítico: vacío = nadie entra a las rutas admin).
    if (adminIds.size > 0) {
      checks.push({
        id: "admins",
        label: "Administradores",
        status: "ok",
        detail: `${adminIds.size} ${adminIds.size === 1 ? "admin configurado" : "admins configurados"}.`,
      });
    } else {
      checks.push({
        id: "admins",
        label: "Administradores",
        status: "fail",
        detail: "ADMIN_DISCORD_IDS vacío: nadie puede usar el panel.",
        fix: `Añade tu ID de Discord a ADMIN_DISCORD_IDS en el .env y reinicia. Tu ID: ${user.discordId}`,
      });
    }

    // 3. Base de datos (opcional: sin ella va en memoria/stateless).
    try {
      const { dbAvailable } = await import("../../db/client.js");
      const ok = await dbAvailable();
      checks.push(
        ok
          ? { id: "database", label: "Base de datos", status: "ok", detail: "Postgres responde." }
          : {
              id: "database",
              label: "Base de datos",
              status: "warn",
              detail: "Sin conexión: sesiones stateless, jobs y logs en memoria.",
              fix: "Levanta Postgres (docker compose) y revisa DATABASE_URL. Opcional: el bot funciona sin ella.",
            },
      );
    } catch {
      checks.push({
        id: "database",
        label: "Base de datos",
        status: "warn",
        detail: "Sin conexión: modo memoria.",
        fix: "Revisa DATABASE_URL. Opcional: el bot funciona sin ella.",
      });
    }

    // 4. Bot conectado (warn: se puede encender desde aquí si hay token).
    try {
      const { botInfo } = await import("../../bot/client.js");
      const info = botInfo();
      checks.push(
        info.connected
          ? { id: "bot", label: "Bot conectado", status: "ok", detail: `En línea como ${info.tag ?? "bot"}.` }
          : {
              id: "bot",
              label: "Bot conectado",
              status: "warn",
              detail: env.DISCORD_TOKEN ? "Apagado (enciéndelo abajo)." : "Apagado (primero el token).",
              fix: env.DISCORD_TOKEN ? undefined : "Completa el paso del token y reinicia.",
            },
      );
    } catch {
      checks.push({ id: "bot", label: "Bot conectado", status: "warn", detail: "Estado desconocido." });
    }

    // 5. Servidor asignado (warn: vacío = responde en todos).
    try {
      const { readBotConfig } = await import("./config.js");
      const cfg = await readBotConfig();
      const guildId = typeof cfg.guildId === "string" ? cfg.guildId : "";
      checks.push(
        guildId
          ? { id: "guild", label: "Servidor asignado", status: "ok", detail: "El bot responde solo en tu servidor." }
          : {
              id: "guild",
              label: "Servidor asignado",
              status: "warn",
              detail: "Sin asignar: el bot responde en todos los servidores.",
              fix: "Elígelo en Configuración cuando el bot esté conectado.",
            },
      );
    } catch {
      checks.push({ id: "guild", label: "Servidor asignado", status: "warn", detail: "No se pudo leer." });
    }

    const blocked = checks.some((ch) => ch.status === "fail");
    return c.json({ checks, blocked });
  });

  /**
   * Guarda el token del bot desde el wizard: lo verifica contra la API
   * de Discord (sin arrancar nada), lo persiste en .env, lo aplica en
   * caliente y conecta el bot. Sin reinicio.
   */
  r.post("/token", requireSetupAccess, async (c) => {
    const { token } = await c.req.json<{ token?: string }>().catch((): { token?: string } => ({}));
    const t = typeof token === "string" ? token.trim() : "";
    if (t.length < 50 || /\s/.test(t)) {
      return c.json({ error: "token con pinta rara (muy corto o con espacios)" }, 400);
    }
    // Verificación real: ¿responde Discord con este token?
    let tag: string | null = null;
    try {
      const res = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${t}` },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 401 || res.status === 403) {
        return c.json({ error: "Discord dice que el token no vale (401). Revisa que sea el Bot Token, no el Client Secret." }, 400);
      }
      if (!res.ok) return c.json({ error: `Discord respondió HTTP ${res.status}, prueba de nuevo` }, 502);
      const me = (await res.json()) as { id?: string; username?: string };
      if (!me?.id) return c.json({ error: "respuesta rara de Discord, prueba de nuevo" }, 502);
      tag = me.username ?? null;
    } catch (e) {
      return c.json({ error: `no pude hablar con Discord (${String(e).split("\n")[0]}). ¿Hay internet?` }, 502);
    }
    try {
      setEnvKey("DISCORD_TOKEN", t);
    } catch (e) {
      return c.json({ error: `token válido, pero no pude escribir el .env (${String(e)})` }, 500);
    }
    // En caliente: el token se leía solo al arrancar; ahora también en runtime.
    env.DISCORD_TOKEN = t;
    process.env.DISCORD_TOKEN = t;
    logger.info("server", "DISCORD_TOKEN guardado desde el setup ✓");
    try {
      const { connect } = await import("../../bot/client.js");
      const info = await connect(t);
      return c.json({ ok: true, tag: info.tag ?? tag, connected: info.connected });
    } catch (e) {
      // Guardado pero sin conectar (red, intents…): el wizard re-chequea.
      return c.json({ ok: true, tag, connected: false, warning: String(e).split("\n")[0] }, 202);
    }
  });

  /**
   * Primer admin: te añade a ADMIN_DISCORD_IDS (solo en modo bootstrap
   * o siendo ya admin). Sin reinicio: el Set en memoria manda.
   */
  r.post("/claim-admin", requireSetupAccess, async (c) => {
    const user = await getSessionUser(c).catch(() => null);
    if (!user?.discordId) return c.json({ error: "unauthorized" }, 401);
    if (adminIds.size > 0) {
      const { isAdmin } = await import("../env.js");
      if (!isAdmin(user.discordId)) return c.json({ error: "ya hay admins: pídeles acceso" }, 403);
      if (isAdmin(user.discordId)) return c.json({ ok: true, already: true });
    }
    const current = env.ADMIN_DISCORD_IDS.split(",").map((s) => s.trim()).filter(Boolean);
    if (!current.includes(user.discordId)) current.push(user.discordId);
    try {
      setEnvKey("ADMIN_DISCORD_IDS", current.join(","));
    } catch (e) {
      return c.json({ error: `no pude escribir el .env (${String(e)})` }, 500);
    }
    for (const id of current) adminIds.add(id);
    env.ADMIN_DISCORD_IDS = current.join(",");
    process.env.ADMIN_DISCORD_IDS = current.join(",");
    logger.info("server", `admin reclamado desde el setup: ${user.discordId}`);
    return c.json({ ok: true });
  });

  /** Reinicio controlado (tras tocar el .env a mano, p. ej.). */
  r.post("/restart", requireSetupAccess, (c) => {
    logger.warn("server", "reinicio pedido desde el setup (exit 0: lo levanta tu process manager)");
    setTimeout(() => process.exit(0), 600);
    return c.json({ ok: true });
  });

  return r;
}
