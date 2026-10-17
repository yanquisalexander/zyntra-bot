import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export const PLUGINS_DIR = path.resolve(process.cwd(), "data/plugins");

/** Plugins core: viajan con el repo y se siembran en data al arrancar. */
export const CORE_PLUGINS_DIR = path.resolve(process.cwd(), "core-plugins");

export async function ensureDirs() {
  await fs.mkdir(PLUGINS_DIR, { recursive: true });
}

/** Core = tiene `core.json` con `{"core": true}` (sello de la siembra). */
export async function isCore(name: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(pluginDir(name), "core.json"), "utf8");
    return (JSON.parse(raw) as { core?: unknown }).core === true;
  } catch {
    return false;
  }
}

interface CoreManifest {
  core: true;
  version: string;
}

async function readManifest(dir: string): Promise<CoreManifest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, "core.json"), "utf8");
    const m = JSON.parse(raw) as Partial<CoreManifest>;
    if (m.core === true && typeof m.version === "string") return m as CoreManifest;
    return null;
  } catch {
    return null;
  }
}

/**
 * Siembra los core plugins en `data/plugins/`:
 * - si falta: copia todo (`plugin.js`, `schema.yml`, `config.toml`, `core.json`).
 * - si existe con versión anterior: sobrescribe `plugin.js` + `schema.yml` + sello.
 * La `config.toml` y `vars.json` del usuario nunca se tocan.
 */
export async function seedCorePlugins(): Promise<string[]> {
  const seeded: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(CORE_PLUGINS_DIR, { withFileTypes: true });
  } catch {
    return seeded; // sin carpeta core: nada que sembrar
  }
  await ensureDirs();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const src = path.join(CORE_PLUGINS_DIR, name);
    const manifest = await readManifest(src);
    if (!manifest) continue;
    const dest = pluginDir(name);
    const current = await readManifest(dest);
    if (!current) {
      await fs.mkdir(dest, { recursive: true });
      for (const f of ["plugin.js", "schema.yml", "config.toml", "core.json"]) {
        try {
          await fs.copyFile(path.join(src, f), path.join(dest, f));
        } catch {
          /* archivo opcional ausente en origen */
        }
      }
      seeded.push(name);
    } else if (current.version !== manifest.version) {
      for (const f of ["plugin.js", "schema.yml", "core.json"]) {
        try {
          await fs.copyFile(path.join(src, f), path.join(dest, f));
        } catch {
          /* noop */
        }
      }
      seeded.push(`${name} (actualizado a ${manifest.version})`);
    }
  }
  return seeded;
}

export function pluginDir(name: string) {
  return path.join(PLUGINS_DIR, name);
}

export async function listPluginNames(): Promise<string[]> {
  await ensureDirs();
  const entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

export async function readCode(name: string): Promise<string> {
  return fs.readFile(path.join(pluginDir(name), "plugin.js"), "utf8");
}

export async function readConfigToml(name: string): Promise<string> {
  try {
    return await fs.readFile(path.join(pluginDir(name), "config.toml"), "utf8");
  } catch {
    return "";
  }
}

export async function readSchema(name: string): Promise<string> {
  try {
    return await fs.readFile(path.join(pluginDir(name), "schema.yml"), "utf8");
  } catch {
    return "";
  }
}

export async function writeSchema(name: string, raw: string) {
  const { parseSchemaYaml } = await import("./schema.js");
  const parsed = parseSchemaYaml(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  await fs.mkdir(pluginDir(name), { recursive: true });
  await fs.writeFile(path.join(pluginDir(name), "schema.yml"), raw, "utf8");
  return parsed.schema;
}

/** Guarda una revisión de config (rollback futuro). DB opcional: nunca falla. */
export async function snapshotConfigRevision(pluginName: string, toml: string, discordId?: string | null) {
  try {
    const { getDb } = await import("../db/client.js");
    const { pluginConfigRevisions, users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const db = getDb();
    let createdBy: string | null = null;
    if (discordId) {
      const rows = await db.select().from(users).where(eq(users.discordId, discordId)).limit(1);
      createdBy = rows[0]?.id ?? null;
    }
    await db.insert(pluginConfigRevisions).values({ pluginName, toml, createdBy } as never);
  } catch {
    /* DB opcional */
  }
}

export function parseConfig(toml: string): Record<string, unknown> {
  if (!toml.trim()) return {};
  const v = parseToml(toml);
  if (typeof v !== "object" || v === null) throw new Error("config TOML debe ser un objeto");
  return v as Record<string, unknown>;
}

export async function writeCode(name: string, code: string) {
  await fs.mkdir(pluginDir(name), { recursive: true });
  await fs.writeFile(path.join(pluginDir(name), "plugin.js"), code, "utf8");
}

export async function writeConfig(name: string, toml: string) {
  parseConfig(toml); // valida antes de guardar
  await fs.mkdir(pluginDir(name), { recursive: true });
  await fs.writeFile(path.join(pluginDir(name), "config.toml"), toml, "utf8");
}

export async function deletePlugin(name: string) {
  await fs.rm(pluginDir(name), { recursive: true, force: true });
}

export async function createPlugin(
  name: string,
  code: string,
  config: Record<string, unknown> = {},
  schema?: string,
) {
  if (!/^[a-z0-9-_]{2,32}$/.test(name)) throw new Error("nombre inválido (a-z, 0-9, -, _)");
  try {
    await fs.access(pluginDir(name));
    throw new Error("ya existe un plugin con ese id");
  } catch (e) {
    if (e instanceof Error && e.message === "ya existe un plugin con ese id") throw e;
    // No existe: seguimos.
  }
  await fs.mkdir(pluginDir(name), { recursive: true });
  await fs.writeFile(path.join(pluginDir(name), "plugin.js"), code, "utf8");
  await fs.writeFile(path.join(pluginDir(name), "config.toml"), stringifyToml(config), "utf8");
  if (schema) await writeSchema(name, schema);
}

export type PluginTemplateId = "hola" | "ping" | "welcome" | "contador";

export const PLUGIN_TEMPLATES: Record<
  PluginTemplateId,
  { code: (displayName: string) => string; config: Record<string, unknown>; schema?: string }
> = {
  hola: {
    config: { enabled: true },
    code: (displayName) => `definePlugin({
  // Nombre visible en el panel (puedes cambiarlo libremente:
  // el ID es la carpeta, no tiene que coincidir).
  name: ${JSON.stringify(displayName)},
  version: "0.1.0",
  description: "Mi plugin",

  setup(api) {
    api.commands.register("hola", async (ctx) => {
      await api.reply(ctx.message, \`¡Hola, \${ctx.message.author.username}!\`);
    }, { description: "Saluda" });

    api.log.info("plugin listo");
  },
});
`,
  },
  ping: {
    config: { enabled: true },
    code: (displayName) => `definePlugin({
  name: ${JSON.stringify(displayName)},
  version: "0.1.0",
  description: "Comando de ejemplo !ping",

  setup(api) {
    api.commands.register(
      "ping",
      async (ctx) => {
        const ms = Date.now() - ctx.message.createdTimestamp;
        await api.reply(ctx.message, \`Pong! (\${ms}ms)\`);
      },
      { description: "Responde pong" },
    );
  },
});
`,
  },
  welcome: {
    config: { enabled: true, welcomeMessage: "¡Bienvenido/a al servidor!", channelId: "" },
    code: (displayName) => `definePlugin({
  name: ${JSON.stringify(displayName)},
  version: "0.1.0",
  description: "Da la bienvenida a nuevos miembros",

  setup(api) {
    const message = api.config.welcomeMessage ?? "¡Bienvenido/a al servidor!";
    const channelId = api.config.channelId || null;

    api.events.on("guildMemberAdd", async (member) => {
      try {
        const channel = channelId
          ? await member.guild.channels.fetch(channelId).catch(() => null)
          : member.guild.systemChannel;
        if (!channel) return;
        await api.sendMessage(channel, \`\${message} \${member.user.username}!\`);
      } catch (e) {
        api.log.error(\`welcome: \${String(e)}\`);
      }
    });

    api.log.info("welcome listo");
  },
});
`,
  },
  contador: {
    config: { enabled: true },
    schema: `version: 1
categories:
  - name: General
    description: El contador persiste entre comandos y reinicios.
fields:
  - key: contador
    type: variable
    varType: number
    label: Contador
    description: Cuántas veces se ha usado !contador.
    category: General
    default: 0
`,
    code: (displayName) => `definePlugin({
  name: ${JSON.stringify(displayName)},
  version: "0.1.0",
  description: "Cuenta cuántas veces se usa !contador (api.vars)",

  setup(api) {
    api.commands.register(
      "contador",
      async (ctx) => {
        const n = await api.vars.incr("contador", 1);
        await api.reply(ctx.message, \`Van \${n} 🎉\`);
      },
      { description: "Suma 1 al contador persistente" },
    );
  },
});
`,
  },
};

export const DEFAULT_PLUGIN_CODE = `definePlugin({
  // Nombre visible en el panel (puedes cambiarlo libremente:
  // el ID es la carpeta, no tiene que coincidir).
  name: "__NAME__",
  version: "0.1.0",
  description: "Mi plugin",

  setup(api) {
    api.commands.register("hola", async (ctx) => {
      await api.reply(ctx.message, \`¡Hola, \${ctx.message.author.username}!\`);
    }, { description: "Saluda" });

    api.log.info("plugin listo");
  },
});
`;
