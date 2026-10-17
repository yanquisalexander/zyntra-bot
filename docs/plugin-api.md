# Zyntra Bot — API de plugins

Escribe `data/plugins/<nombre>/plugin.js`:

```js
definePlugin({
  name: "Welcome", // nombre visible en el panel (no tiene que coincidir con la carpeta)
  version: "1.0.0",
  description: "Welcome new members",

  setup(api) {
    const msg = api.config.welcomeMessage ?? "¡Bienvenido!";

    api.events.on("guildMemberAdd", async (member) => {
      const ch = member.guild.systemChannel;
      if (!ch) return;
      await api.sendMessage(ch, `${msg} ${member.user.username}!`);
    });

    api.commands.register("hola", async (ctx) => {
      await api.reply(ctx.message, `¡Hola, ${ctx.message.author.username}!`);
    });
  },

  async teardown() {
    // limpieza extra opcional (el manager ya retira listeners/comandos)
  },
});
```

## `api`

| Campo | Descripción |
|---|---|
| `api.config` | Objeto parseado de `config.toml` (solo lectura; edítalo en la pestaña Config) |
| `api.botConfig.prefix` | Prefijo de comandos (`!` por defecto) |
| `api.client` | `discord.js` Client (acceso directo, sin re-imports) |
| `api.events.on/off` | Eventos discord.js… o bus inter-plugin con `plugin:evento` |
| `api.emit(nombre, …args)` | Emite al bus con tu namespace (`twitch:stream-started`) |
| `api.commands.register/unregister` | `!nombre` y `/nombre` (con `slash: { description, options }`) |
| `api.discord.button/selectMenu/modal` | Componentes de Discord (botones, selects, modales) |
| `api.sendMessage(ch, text)` | Envía a un canal enviable |
| `api.reply(msg, text)` | Responde a un mensaje |
| `api.sendEmbed(ch, embed)` | Envía `{ embeds: [embed] }` |
| `api.log.{info,warn,error}` | Log atribuido a tu plugin (visible en /logs) |
| `api.onCleanup(fn)` | Registra limpieza extra al descargar/recargar |
| `api.jobs.*` | Tareas programadas (ver sección Tareas) |
| `api.vars.*` | Variables persistentes entre comandos (ver sección Variables) |
| `api.http.get/post` | Endpoints públicos `/plugin-routes/<plugin>/<path>` (ver sección HTTP) |
| `api.lib.importUrl` | Importa ESM remoto (esm.sh) con caché en disco (ver sección Librerías) |

## Slash commands y componentes de Discord

```js
// Slash command: se registra como /nombre en el guild (instantáneo).
api.commands.register(
  "ping",
  async (ctx) => { await api.reply(ctx.message, "Pong!"); },
  { description: "Responde pong", slash: { description: "Responde pong con latencia", options: [{ name: "eco", type: "string", required: false }] } },
);

// Botón: devuelve el descriptor para meterlo en un mensaje/embed.
const btn = api.ui.discord.button({ id: "ver", label: "Ver directo", style: "primary" }, async (ctx) => {
  await ctx.reply("🔴 https://twitch.tv/alguien");
});
await api.sendMessage(channel, { content: "¿Quieres verlo?", components: [{ type: 1, components: [btn] }] });

// Select menu
const sel = api.ui.discord.selectMenu({ id: "juego", placeholder: "Elige juego", options: [{ label: "Elden Ring", value: "er" }] }, async (ctx) => {
  await ctx.reply(`Elegiste: ${ctx.values[0]}`);
});

// Modal
const modal = api.ui.discord.modal({ id: "reporte", label: "Reportar", components: [{ type: 1, components: [{ type: 4, custom_id: "texto", label: "Detalles" }] }] }, async (ctx) => {
  await ctx.reply("Gracias por el reporte");
});
```

- **Slash**: guild-scoped (instantáneo). Sin `guildId` configurado o sin cliente listo, se omite (el `!nombre` sigue funcionando). Opciones: `string|number|boolean|user|channel|role`, `required`, `choices`, `min_value`, `max_value` (máx 25).
- **Componentes**: `customId` namespaced `plugin:tipo:id`. El handler recibe `{ interaction, customId, values, user, channel, guild, reply, deferReply, editReply, showModal }`. Errores aislados por handler.
- Se retiran solos al recargar/apagar. Sin oyentes/handlers huérfanos.

## Endpoints públicos (`api.http`)

```js
setup(api) {
  // POST /plugin-routes/mi-plugin/eventsub (público, sin sesión: webhooks)
  api.http.post("eventsub", async (ctx) => {
    const sig = ctx.headers["twitch-eventsub-message-signature"];
    // ctx.rawBody: bytes exactos · ctx.text() · ctx.json() · ctx.query
    return "ok"; // string → text · objeto → json · Response tal cual · undefined → 204
  }, { raw: true }); // raw: sin parsear (imprescindible para firmas HMAC)
}
```

- Rutas: `GET`/`POST`, `path` relativo (`a-z, 0-9, -, _, /`, máx 64), máx 8 por plugin. Se retiran solas al recargar/apagar. Salen en la card del plugin (🌐).
- **Públicas a propósito** (sin login): son para webhooks de terceros. La seguridad la pones tú (HMAC con secreto en `config.toml`/`vars`, compara con `timingSafeEqual`).
- Límites: body 100KB parseado / 256KB crudo, timeout 10s por handler, 60 req/min por IP. Método erróneo → 405.
- Ejemplo completo: `core-plugins/twitch/plugin.js` (EventSub: challenge + HMAC + altas/bajas vía Helix).

## Librerías externas (`api.lib`)

```js
const { AppTokenAuthProvider } = await api.lib.importUrl(
  "https://esm.sh/@twurple/auth@8.0.3?bundle&target=node",
);
```

- Solo `https://esm.sh` y `cdn.jsdelivr.net`, **versión exacta obligatoria** (`paquete@1.2.3`). En esm.sh exige `?bundle&target=node` (un solo fichero autocontenido).
- Descarga con timeout 15s y tope 5MB, **caché en `data/.cache/esm/`** (segundos arranques funcionan offline). Lanza si falla: captúralo y ten plan B.
- Límite conocido: paquetes cuyo bundle esm.sh reparta en **chunks** no cargan (Node no resuelve sus imports desde disco). `@twurple/auth` sí es autocontenido; `@twurple/api` no.
- **Paquetes del host (`api.lib.pkg`)**: si la dependencia está en el `package.json` raíz, úsala así — offline, versionada con el repo y con resolución normal de dependencias (así resuelve `@twurple/api` + `@twurple/auth` el plugin Twitch):
  ```js
  const { AppTokenAuthProvider } = await api.lib.pkg("@twurple/auth");
  const { ApiClient } = await api.lib.pkg("@twurple/api");
  const client = new ApiClient({ authProvider: new AppTokenAuthProvider(id, secret) });
  const users = await client.users.getUsersByNames(["alguien"]);
  ```
  Lanza si el paquete no está instalado (`pnpm add <paquete>`). Patrón recomendado: `pkg` primero, `importUrl` como plan B, `fetch` manual como plan C.
- El código remoto corre in-process con tus mismos privilegios: solo URLs que confíes, siempre pineadas.

## Bus inter-plugin (`api.emit` + `events.on("plugin:evento")`)

```js
// twitch/plugin.js — emite con namespace automático (siempre `twitch:…`)
await api.emit("stream-started", { login, title, game, url });

// otro plugin — escucha eventos de cualquiera (también los tuyos propios)
setup(api) {
  api.events.on("twitch:stream-started", async (ev) => {
    await api.sendMessage(canal, `🔴 ${ev.name} en vivo: ${ev.title} ${ev.url}`);
  });
}
```

- Sin `:` es discord.js (`messageCreate`, …); **con `:` es bus** (`twitch:stream-started`). Nombres `a-z, 0-9, -, _` (máx 48 por parte).
- `emit` es async y espera a todos los oyentes; un oyente que falla **no tumba al emisor** (error aislado con log `plugin:<oyente>`). Sin oyentes = noop.
- Los oyentes se retiran solos al recargar/apagar (sin huérfanos). `events.off("twitch:stream-started", handler)` retira uno concreto.
- El plugin Twitch emite `stream-started` (`{login, name, title, game, viewers, url, startedAt, via}`) y `stream-ended` (`{login, via}`) tanto por polling como por webhook, con `via` = `"poll"` o `"eventsub"` (también sale en el log del aviso).

## `console.*` → logger

Dentro de `setup`, handlers de `api.events`, comandos y `teardown`, los `console.log/info/debug/warn/error/trace/dir` se redirigen automáticamente al logger como `plugin:<nombre>` (visibles en `/logs`, SSE y panel). Fuera de plugins, `console` funciona igual que siempre.

- `log`/`info`/`debug`/`dir` → nivel `info` · `warn`/`trace` → `warn` · `error` → `error`
- Soporta formato `console.log("hola %s", x)` y objetos (vía `util.format`/`inspect`).
- El `console.*` del top-level de `plugin.js` también se intenta atribuir (best-effort).

## Tareas programadas (`api.jobs`)

```js
setup(api) {
  api.jobs.every("resumen", "5m", async () => {
    api.log.info("toc: hora del resumen");
  }, { description: "Resumen periódico" });

  api.jobs.cron("buenos-dias", "0 9 * * *", async () => { ... });
  api.jobs.in("aviso", 10 * 60 * 1000, async () => { ... }); // una vez, sobrevive reinicios
  api.jobs.at("cita", new Date("2026-10-20T10:00:00"), async () => { ... });
}
```

- Intervalos: `"30s"`, `"5m"`, `"2h"`, `"1d"` o ms (mínimo 10s). Cron de 5 campos.
- IDs estables `${plugin}:${nombre}`: verás cada tarea en **Tareas** con próxima ejecución, historial, pausar/reanudar, ejecutar ahora y cancelar one-shots.
- Un cron mal formado no tumba el plugin: la tarea queda marcada inválida.
- Si una ejecución sigue en curso al tocarle turno, se salta y se avisa. Timeout 30s por defecto.
- Los one-shots pendientes sobreviven reinicios (se adoptan al re-registrarse); si vencieron, corren al volver.
- Apagar/recargar el plugin cancela sus timers pendientes.
- El historial y las pausas viven en Postgres si está disponible (`pnpm db:migrate` para crear `job_schedules`/`job_runs`); sin DB todo funciona en memoria.

## Variables persistentes (`api.vars`)

```js
// schema.yml: declara primero (type: variable + varType)
fields:
  - key: contador
    type: variable
    varType: number
    label: Contador
    category: General
    default: 0

// plugin.js: úsala entre comandos
setup(api) {
  api.commands.register("contador", async (ctx) => {
    const n = await api.vars.incr("contador", 1);
    await api.reply(ctx.message, `Van ${n} 🎉`);
  });
}
```

- `get(key, fallback?)`, `set`, `incr`/`decr` (devuelven el nuevo valor), `reset` (vuelve al default), `has`, `all()`. Todo async.
- **Solo claves declaradas**: lo no declarado falla con error claro. Sin `schema.yml`, todo `api.vars` falla.
- Viven en `vars.json` (nunca en `config.toml`: **no disparan recarga**). Sobreviven reinicios y recargas.
- `incr` concurrente no pierde incrementos. Tipos validados (`number`/`string`/`boolean`).
- Panel: el campo se edita en **Ajustes** con badge live, y la pestaña **Variables** muestra todas con su valor en directo (editar, reset, borrar).

## UI declarativa (`api.ui`)

```js
setup(api) {
  api.ui.registerTab({ id: "directos", label: "Directos", icon: "video" });
  api.ui.data("en-vivo", async () => [...]);
  api.ui.widget("directos", { kind: "table", title: "Ahora mismo", data: "en-vivo",
    columns: [{ key: "login", label: "Streamer" }] });
  api.ui.widget("directos", { kind: "actions", items: ["revisar"] });
  api.ui.action({ id: "revisar", label: "Comprobar ahora" }, async () => {
    await revisar();
    return "chequeo hecho ✓";
  });
}
```

- Widgets: `stat`, `table`, `list`, `line`/`bars` (series numéricas), `text`, `actions`. Sin HTML ni JS del plugin en el navegador: todo se renderiza con componentes del core.
- Los providers se invocan por petición (timeout 10s, errores aislados por widget). Acciones por POST (timeout 15s, log de auditoría, `confirm` opcional).
- `refreshMs` por widget (mínimo 5s; defecto: la página refresca cada 15s).
- Todo se limpia en teardown/reload: sin tabs huérfanas. IDs `a-z, 0-9, -, _` (máx 48).
- `kind: "html"` está reservado para v2 (sanitizado + CSP); hoy el validador lo rechaza.

## ID vs nombre visible

- El **ID** es el nombre de la carpeta en `data/plugins/` (p. ej. `welcome`). Es estable: se usa en rutas API, logs (`plugin:<id>`) y `api.name`.
- El **`name`** de `definePlugin` es el **nombre visible** en el panel. Es opcional y libre: puede diferir de la carpeta, con espacios y mayúsculas. Si falta o es vacío, se muestra el ID.

## Reglas

- Un throw en tu handler **no tumba el bot**: se loguea con `plugin:<nombre>` y se sigue.
- `setup` tiene timeout de 10s.
- El hot reload valida sintaxis (`node --check`) antes de tocar la versión activa; si falla, se conserva la anterior.
- No uses `while(true)` ni bloquees el event loop: v1 es in-process, sin aislamiento contra bucles infinitos (ver `docs/architecture.md`).

## `schema.yml` (formulario de ajustes, opcional)

Si el plugin trae `schema.yml`, la pestaña **Ajustes** del editor pinta un formulario agrupado por
categoría. El archivo **solo se edita como texto**; categoría y descripción son ayuda visual y no
afectan al runtime. Los valores siguen viviendo en `config.toml` (`api.config` no cambia). Sin
`schema.yml`, todo queda como siempre.

```yaml
version: 1
categories:
  - name: General
    description: Lo básico para funcionar
fields:
  - key: welcomeMessage
    type: string # string | text | number | boolean | select | role | role_list | variable | secret
    label: Mensaje de bienvenida
    description: Se envía al canal cuando entra alguien.
    category: General
    default: "¡Bienvenido/a!"
  - key: modRole
    type: role # picker con los roles del servidor (se guarda el ID)
    label: Rol de moderación
    description: Vacío = sin rol.
    default: ""
  - key: vipRoles
    type: role_list # multi-picker (se guarda array de IDs en config.toml)
    label: Roles VIP
    default: []
  - key: channelId
    type: string
    label: Canal
    description: ID del canal. Vacío = canal del sistema.
    default: ""
  - key: loud
    type: boolean
    label: Modo ruidoso
    category: General
    default: false
  - key: color
    type: select
    label: Color
    options: [rosa, violeta, menta]
    category: Apariencia
    default: rosa
```

- `key`: `[A-Za-z0-9_]` y único. `select` exige `options` no vacío.
- `role` guarda un ID de rol (string; `""` = ninguno). `role_list` guarda un array de IDs
  (`[]` = ninguno). Ambos usan picker con los roles del servidor único donde está el bot
  (`GET /api/discord/roles`); si el bot está desconectado, el campo deja pegar el ID a mano.
- `secret` = texto que en el formulario sale enmascarado (claves, tokens). Vive en `config.toml` igual.
- `hidden: true` = no se muestra en el panel (ajustes internos), pero se guarda y valida igual.
- `required`, `min`/`max` (números) se validan al guardar; el resto de claves de `config.toml` se conservan.
- Guardar el formulario reescribe `config.toml` (se pierden los comentarios): para conservarlos, edita `config.toml` como archivo.
- ¿Pereza? Botón **"Generar desde la config actual"**: crea el `schema.yml` inicial desde tus claves.

## Core plugins (vienen con la app)

Viven en `core-plugins/<id>/` (con `core.json`) y se siembran en `data/plugins/` al arrancar:
código + `schema.yml` se actualizan con la versión del repo, `config.toml`/`vars.json` nunca se tocan.
En el panel salen con badge **Core**: solo ajustes, variables y activar/desactivar —
código, schema, `config.toml` en crudo y borrado devuelven 403. Ejemplo incluido: `twitch`
(avisos de directos; añadir un streamer = sumarlo en Ajustes, sin tocar código).
Soporta **webhook instantáneo** (EventSub `stream.online/offline` en
`POST /plugin-routes/twitch/eventsub`): activa `useWebhook` y pon tu URL
pública `https://…` (puerto 443) en `publicBaseUrl`. Usa twurple local
(`ApiClient` + `AppTokenAuthProvider`) con Helix manual como respaldo.
Sin webhook, sigue el polling de siempre.

## `config.toml` (recarga sola ✨)

Guardar `config.toml` (desde el panel o el archivo) **recarga el plugin solo** con debounce: el watcher
detecta el cambio, valida y aplica. Si la config es inválida, se conserva la versión activa y verás el
error en los logs. No hace falta pulsar Recargar para cambios de config (el código sí lo necesita).

Cada arranque, encendido y recarga lee el archivo fresco: `api.config` es una foto del momento de carga.

## `config.toml` (formato)

```toml
welcomeMessage = "¡Bienvenido/a!"
channelId = ""
```

Se valida con TOML estricto antes de guardar; cada guardado crea una revisión en Postgres (`plugin_config_revisions`).
