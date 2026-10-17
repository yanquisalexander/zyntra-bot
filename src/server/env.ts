import { z } from "zod";

const schema = z.object({
  DISCORD_TOKEN: z.string().optional().default(""),
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID requerido"),
  DISCORD_CLIENT_SECRET: z.string().min(1, "DISCORD_CLIENT_SECRET requerido"),
  DISCORD_REDIRECT_URI: z.string().default("http://localhost:3000/api/auth/callback"),
  ADMIN_DISCORD_IDS: z.string().default(""),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET debe tener >= 32 chars"),
  DATABASE_URL: z.string().default("postgres://zyntra:zyntra@localhost:5432/zyntra"),
  PORT: z.coerce.number().default(3000),
  BOT_PREFIX: z.string().default("!"),
  BYPASS_ADMIN_SERVER_CHECK: z
    .union([z.boolean(), z.string()])
    .optional()
    .default(false)
    .transform((v) =>
      v === true ||
      (typeof v === "string" && ["1", "true", "yes", "on"].includes(v.toLowerCase().trim()))
        ? true
        : false,
    ),
});

export const env = schema.parse(process.env);
export const adminIds = new Set(
  env.ADMIN_DISCORD_IDS.split(",").map((s) => s.trim()).filter(Boolean),
);
export const isAdmin = (discordId: string) => adminIds.has(discordId);
