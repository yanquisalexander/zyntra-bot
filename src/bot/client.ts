import { Client, GatewayIntentBits, Partials } from "discord.js";
import { logger } from "../plugins/logger.js";

let client: Client | null = null;

export function getClient(): Client {
  if (!client) {
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
      partials: [Partials.Channel],
    });
    client.on("error", (e) => logger.error("bot", `client error: ${String(e)}`));
    client.on("shardError", (e) => logger.error("bot", `shard error: ${String(e)}`));
  }
  return client;
}

export function botInfo() {
  const c = client;
  return {
    connected: !!c?.isReady(),
    tag: c?.user?.tag ?? null,
    id: c?.user?.id ?? null,
    guilds: c?.guilds.cache.size ?? 0,
    uptime: c?.uptime ?? 0,
    ping: c?.ws.ping ?? -1,
  };
}

export async function connect(token: string) {
  const c = getClient();
  if (c.isReady()) return botInfo();
  if (!token) throw new Error("DISCORD_TOKEN no configurado (ver .env)");
  await c.login(token);
  logger.info("bot", `conectado como ${c.user?.tag}`);
  return botInfo();
}

export async function disconnect() {
  const c = client;
  if (c) await c.destroy();
  client = null;
  logger.info("bot", "desconectado");
}
