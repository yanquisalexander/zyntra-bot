# Zyntra Bot — notas de arquitectura

## IDs: UUIDv7, no Snowflake

Se evaluó Snowflake (bigint 64b: timestamp + worker + secuencia) frente a UUIDv7.

- **Snowflake**: compacto (8B), monotónico, gran throughput. Contras: requiere `workerId` coordinado por instancia (rompe al escalar a N réplicas self-hosted sin coordinación), expone timestamp, fricción en JS (`bigint` vs `number`, JSON como string), generación custom en Drizzle (`$defaultFn`).
- **UUIDv7** (elegido): time-ordered (buena localidad B-tree, sin fragmentación de v4), generación nativa en Postgres 18 (`select uuidv7()`), cero coordinación, tipo estándar portable, Drizzle: `uuid("id").primaryKey().default(sql`uuidv7()`)`. Requiere **Postgres ≥ 18**.

Volumen de zyntra (usuarios, sesiones, plugins, logs) no justifica Snowflake.

> **Compatibilidad PG**: los UUIDv7 se generan en la aplicación (`uuid.v7()` +
> Drizzle `$defaultFn`), no con `uuidv7()` nativo de PG18. Funciona en
> cualquier Postgres ≥ 12, incluido un PG15 local sin Docker.

## Aislamiento de plugins (honesto)

v1 ejecuta plugins **in-process** con `import()` dinámico + `try/catch` por handler/disparo.

- ✅ Aísla: errores de sintaxis (pre-check), errores en `setup`, throws en comandos/eventos, rejections, timeouts de setup, registros duplicados, listeners huérfanos (registry + teardown).
- ❌ No aísla: bucles infinitos, bloqueo del event loop, fugas de memoria, `process.exit()`. Un `try/catch` no es sandbox.
- Mitigación v2 propuesta: `worker_threads` con bridge serializable de la API (los objetos discord.js no son clonables directamente → requiere proxy RPC).

El admin self-hosted acepta código arbitrario; el límite actual evita interferencias *accidentales*, no código malicioso.
