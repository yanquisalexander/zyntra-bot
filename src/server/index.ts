import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { logger as honoLogger } from "hono/logger";
import { env } from "./env.js";
import { getSessionUser } from "./session.js";
import { installConsoleBridge } from "../plugins/consoleBridge.js";
import { logFile } from "../plugins/logFile.js";
import { renderShell } from "./ssr.js";
import { renderLoginPage } from "./loginPage.js";

// Redirige los console.* de los plugins al logger (panel /logs + SSE).
// Debe instalarse antes de cargar ningún plugin.
installConsoleBridge();
// Logs persistentes a disco (logs/YYYY/MM/DD.log) con rotación y autocleanup.
await logFile.init().catch((e) => logger.error("server", `logFile init: ${String(e)}`));
import { getClient } from "../bot/client.js";
import { PluginManager } from "../plugins/manager.js";
import { seedCorePlugins } from "../plugins/store.js";
import { logger } from "../plugins/logger.js";
import { auth } from "./routes/auth.js";
import { startConfigWatcher } from "../plugins/watcher.js";
import { pluginsRoutes } from "./routes/plugins.js";
import { configRoutes, readBotConfig } from "./routes/config.js";
import { logsRoutes } from "./routes/logs.js";
import { botRoutes } from "./routes/bot.js";
import { discordRoutes } from "./routes/discord.js";
import { jobsRoutes } from "./routes/jobs.js";
import { listUiTabs, uiRoutes } from "./routes/ui.js";
import { docsRoutes } from "./routes/docs.js";
import { pluginRoutes } from "./routes/pluginRoutes.js";
import { setupRoutes } from "./routes/setup.js";

const app = new Hono();
app.use("*", honoLogger());

const client = getClient();
const manager = new PluginManager(client);

app.route("/api/auth", auth);
app.route("/api/plugins", pluginsRoutes(manager));
app.route("/api/config", configRoutes((p) => {
  manager.prefix = p || "!";
}, (g) => {
  manager.guildId = g || "";
}));

// Hidrata prefijo y servidor al arrancar (si no, el filtro single-server
// y el prefijo guardado no aplicarían hasta el próximo guardado).
readBotConfig().then((cfg) => {
  if (typeof cfg.prefix === "string" && cfg.prefix) manager.prefix = cfg.prefix;
  if (typeof cfg.guildId === "string") manager.guildId = cfg.guildId;
}).catch(() => undefined);
app.route("/api/logs", logsRoutes(manager));
app.route("/api/bot", botRoutes());
app.route("/api/discord", discordRoutes());
app.route("/api/jobs", jobsRoutes(manager));
app.route("/api/ui", uiRoutes(manager));
app.route("/api/docs", docsRoutes());
app.route("/api/setup", setupRoutes());

app.get("/api/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Endpoints públicos de plugins (webhooks). ANTES de estáticos y del catch-all:
// si no, estas peticiones recibirían HTML en vez del handler del plugin.
app.route("/plugin-routes", pluginRoutes(manager));

// Estáticos compilados por Vite (dist/). Hono genera el HTML vía manifest.
app.use("/*", serveStatic({ root: "./dist" }));

// Login page standalone: sin sesión se sirve directo, sin flash del panel.
app.get("/login", async (c) => {
  const user = await getSessionUser(c).catch(() => null);
  if (user) return c.redirect("/", 302);
  return c.html(renderLoginPage(c.req.query("error")));
});

app.get("*", async (c) => {
  const user = await getSessionUser(c).catch(() => null);
  if (!user) return c.redirect("/login", 302);
  const { botInfo } = await import("../bot/client.js");
  return c.html(
    renderShell({ user, bot: { ...botInfo(), hasToken: !!env.DISCORD_TOKEN }, plugins: manager.list(), uiTabs: listUiTabs(manager), flags: { bypassAdminServerCheck: env.BYPASS_ADMIN_SERVER_CHECK } }),
  );
});

process.on("unhandledRejection", (e) =>
  logger.error("server", `unhandledRejection: ${String(e)}`),
);
process.on("uncaughtException", (e) =>
  logger.error("server", `uncaughtException: ${String((e as Error)?.stack ?? e)}`),
);

const port = env.PORT;
logger.info("server", `arrancando en :${port}`);
if (env.BYPASS_ADMIN_SERVER_CHECK) {
  logger.warn(
    "server",
    "BYPASS_ADMIN_SERVER_CHECK activado: cualquier admin del panel (ADMIN_DISCORD_IDS) puede configurar el bot para servidores donde no es admin. Úsalo solo con personas de total confianza.",
  );
}

// Siembra plugins core (twitch, …) ANTES del autoload: código/schema del
// repo, config del usuario intacta.
const seeded = await seedCorePlugins().catch(() => [] as string[]);
for (const s of seeded) logger.info("server", `core plugin: ${s}`);

// Purge de revisiones VCS con más de 14 días.
{
  const { purgeOldRevisions } = await import("../plugins/store.js");
  purgeOldRevisions()
    .then((n) => { if (n > 0) logger.info("server", `vcs: purgadas ${n} revisiones antiguas`); })
    .catch(() => undefined);
  // Repetir cada 24h mientras el proceso vive.
  setInterval(() => {
    purgeOldRevisions()
      .then((n) => { if (n > 0) logger.info("server", `vcs: purgadas ${n} revisiones antiguas`); })
      .catch(() => undefined);
  }, 24 * 60 * 60 * 1000).unref();
}

// Hidrata el scheduler (pausas + one-shots pendientes) ANTES del autoload,
// para que los setup adopten su estado guardado. Luego autoload + watcher.
// Cada arranque lee config.toml fresco; el watcher recarga solo al guardar.
manager.scheduler
  .hydrate()
  .catch((e) => logger.warn("server", `jobs hydrate: ${String(e)}`))
  .then(() => manager.hydrateState())
  .then(() => manager.autoload())
  .then(() => {
    logger.info("server", "plugins autoload OK");
    startConfigWatcher(manager);
  })
  .catch((e) => logger.error("server", `autoload: ${String(e)}`));

// Autoconexión si hay token.
if (env.DISCORD_TOKEN) {
  const { connect } = await import("../bot/client.js");
  connect(env.DISCORD_TOKEN).catch((e) =>
    logger.error("bot", `autoconnect: ${String(e)} (configura DISCORD_TOKEN)`),
  );
} else {
  logger.warn("bot", "DISCORD_TOKEN vacío: conecta desde el Dashboard");
}

serve({ fetch: app.fetch, port });
