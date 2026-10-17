import { Hono } from "hono";
import { adminIds, env, isAdmin } from "../env.js";
import { createSession, setSessionCookie, destroySession, getSessionUser } from "../session.js";
import { logger } from "../../plugins/logger.js";

export const auth = new Hono();

auth.get("/login", (c) => {
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
  });
  return c.redirect(`https://discord.com/oauth2/authorize?${params}`, 302);
});

auth.get("/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.text("falta ?code", 400);
  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: env.DISCORD_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token: ${tokenRes.status}`);
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!meRes.ok) throw new Error("identify failed");
    const me = (await meRes.json()) as { id: string; username: string; avatar: string | null };
    // Modo bootstrap: sin admins configurados entra cualquiera con Discord
    // (cae en el wizard de setup para reclamar admin). En cuanto hay uno,
    // se exige allowlist como siempre.
    if (adminIds.size > 0 && !isAdmin(me.id)) {
      logger.warn("server", `login denegado para ${me.username} (${me.id})`);
      return c.redirect("/login?error=forbidden", 302);
    }
    if (adminIds.size === 0) {
      logger.warn("server", `primer login en modo bootstrap: ${me.username} (${me.id}) — completa el setup`);
    }
    const signed = await createSession({ id: me.id, discordId: me.id, username: me.username, avatar: me.avatar });
    setSessionCookie(c, signed);
    logger.info("server", `admin login: ${me.username}`);
    return c.redirect("/", 302);
  } catch (e) {
    logger.error("server", `oauth callback: ${String(e)}`);
    return c.text("Error de autenticación", 500);
  }
});

auth.get("/me", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ user: null });
  return c.json({ user });
});

auth.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});
