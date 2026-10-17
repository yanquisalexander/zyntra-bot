# Zyntra Bot

Plataforma self-hosted para administrar un bot de Discord desde un panel web, con sistema de plugins JS editables (Monaco) y hot reload.

## Requisitos

- Node 22+, **pnpm** (nunca npm/npx), Postgres 18+ (`pnpm` + `docker compose up -d`), app Discord (bot token + OAuth2 `identify`).

## Puesta en marcha

```sh
cp .env.example .env   # completa DISCORD_* + ADMIN_DISCORD_IDS + SESSION_SECRET
docker compose up -d
pnpm install
pnpm db:generate && pnpm db:migrate
pnpm dev               # Hono :3000 (en dev apunta a vite :5173; corre `pnpm dev:web` aparte)
# prod:
pnpm build && pnpm start
```

En Windows PowerShell usa `copy .env.example .env`.

## Estructura

- `src/server` Hono + SSR por `manifest.json` + sesiones
- `src/bot` cliente discord.js
- `src/plugins` PluginManager, loader, API, store FS (`data/plugins/<n>/{plugin.js,config.toml}`)
- `src/db` Drizzle + Postgres (registry, sesiones, config, revisiones, logs)
- `web` Vite + React + Tailwind v4 + Monaco
- `docs/plugin-api.md` contrato de plugins
