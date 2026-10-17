import { v7 as uuidv7 } from "uuid";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// PKs: UUIDv7 — time-ordered, generación sin coordinación.
// Se genera en app ($defaultFn) en vez de sql`uuidv7()` para ser compatible
// con Postgres < 18 (p.ej. PG15 local sin Docker). El tipo columna `uuid`
// existe en todas las versiones; solo cambia quién genera el valor.
// Ver docs/architecture.md: se evaluó Snowflake y se descartó para v1
// (requiere worker-id coordinado, fricción bigint en JS).
const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const users = pgTable("users", {
  id: id(),
  discordId: text("discord_id").notNull().unique(),
  username: text("username").notNull(),
  avatar: text("avatar"),
  isAdmin: boolean("is_admin").notNull().default(false),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }).defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const botConfig = pgTable("bot_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const plugins = pgTable("plugins", {
  id: id(),
  name: text("name").notNull().unique(),
  version: text("version").default("0.1.0"),
  enabled: boolean("enabled").notNull().default(true),
  status: text("status").notNull().default("disabled"),
  lastError: text("last_error"),
  lastLoadedAt: timestamp("last_loaded_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const pluginConfigRevisions = pgTable("plugin_config_revisions", {
  id: id(),
  pluginName: text("plugin_name").notNull(),
  toml: text("toml").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const jobSchedules = pgTable("job_schedules", {
  /** ID estable: `${plugin}:${nombre}` para recurrentes y one-shots. */
  id: text("id").primaryKey(),
  pluginName: text("plugin_name").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  expr: text("expr").notNull(),
  description: text("description"),
  timeoutMs: integer("timeout_ms").notNull().default(30000),
  paused: boolean("paused").notNull().default(false),
  status: text("status").notNull().default("scheduled"),
  runs: integer("runs").notNull().default(0),
  skips: integer("skips").notNull().default(0),
  lastOk: boolean("last_ok"),
  lastError: text("last_error"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const jobRuns = pgTable(
  "job_runs",
  {
    id: id(),
    scheduleId: text("schedule_id").notNull(),
    pluginName: text("plugin_name").notNull(),
    ok: boolean("ok"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("job_runs_started_idx").on(t.startedAt)],
);

export const logs = pgTable(
  "logs",
  {
    id: id(),
    level: text("level").notNull(),
    source: text("source").notNull(),
    pluginName: text("plugin_name"),
    message: text("message").notNull(),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("logs_created_idx").on(t.createdAt)],
);
