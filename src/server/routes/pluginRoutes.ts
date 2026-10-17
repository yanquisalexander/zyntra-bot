import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { runWithPlugin } from "../../plugins/consoleBridge.js";
import { logger } from "../../plugins/logger.js";
import type { PluginManager } from "../../plugins/manager.js";
import type { HttpCtx } from "../../plugins/types.js";

const HANDLER_TIMEOUT_MS = 10_000;
/** Body parseado (JSON) permitido por petición. */
const MAX_PARSED_BYTES = 100 * 1024;
/** Body crudo (`raw: true`, firmas HMAC) permitido por petición. */
const MAX_RAW_BYTES = 256 * 1024;
/** Tope de peticiones por IP y minuto (webhooks legítimos van muy por debajo). */
const RATE_PER_MIN = 60;

const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) {
    const oldest = [...hits.keys()][0];
    if (oldest) hits.delete(oldest);
  }
  return arr.length > RATE_PER_MIN;
}

/**
 * Endpoints públicos registrados por plugins (`api.http`).
 * Montaje: `/plugin-routes/:plugin/<subpath>`. Sin sesión a propósito:
 * son webhooks (Twitch EventSub, etc.) llamados por terceros.
 * La seguridad la pone cada plugin (firmas HMAC con secreto en config).
 */
export function pluginRoutes(manager: PluginManager): Hono {
  const r = new Hono();

  r.on(["GET", "POST"], "/*", async (c) => {
    const ip =
      (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim() ||
      c.req.header("x-real-ip") ||
      "local";
    if (rateLimited(ip)) return c.json({ error: "rate limit" }, 429);

    const m = c.req.path.match(/^\/plugin-routes\/([^/]+)\/?(.*)$/);
    if (!m) return c.json({ error: "ruta inválida" }, 404);
    const plugin = decodeURIComponent(m[1]);
    const sub = (m[2] ?? "").replace(/^\/+|\/+$/g, "");
    const method = c.req.method.toUpperCase();

    const found = manager.resolveHttpRoute(plugin, method, sub);
    if (!found) {
      // ¿Existe la subruta con el otro método? → 405, si no 404.
      const other = method === "GET" ? "POST" : "GET";
      if (manager.resolveHttpRoute(plugin, other, sub)) {
        return c.json({ error: `método no permitido (usa ${other})` }, 405);
      }
      return c.json({ error: "ruta no encontrada o plugin no activo" }, 404);
    }
    const { entry } = found;

    let buf: Uint8Array;
    try {
      const ab = await c.req.arrayBuffer();
      buf = new Uint8Array(ab);
    } catch {
      return c.json({ error: "no se pudo leer el body" }, 400);
    }
    const limit = entry.raw ? MAX_RAW_BYTES : MAX_PARSED_BYTES;
    if (buf.length > limit) return c.json({ error: "body demasiado grande" }, 413);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.header())) headers[k.toLowerCase()] = v;
    const query: Record<string, string> = {};
    try {
      new URL(c.req.url).searchParams.forEach((v, k) => {
        query[k] = v;
      });
    } catch {
      /* sin query */
    }
    const ctx: HttpCtx = {
      method: entry.method,
      path: entry.path,
      query,
      headers,
      rawBody: buf,
      text: () => new TextDecoder().decode(buf),
      json: <T = unknown,>() => JSON.parse(new TextDecoder().decode(buf)) as T,
    };

    let out: unknown;
    try {
      out = await Promise.race([
        runWithPlugin(plugin, () => entry.handler(ctx as never) as unknown),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`timeout (${HANDLER_TIMEOUT_MS}ms)`)), HANDLER_TIMEOUT_MS),
        ),
      ]);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 300);
      logger.error(`plugin:${plugin}`, `http ${entry.method} /${entry.path}: ${msg}`);
      if (msg.startsWith("timeout")) return c.json({ error: msg }, 504);
      return c.json({ error: msg }, 500);
    }

    if (out instanceof Response) return out;
    if (out === undefined || out === null) return c.body(null, 204);
    if (typeof out === "string") return c.text(out);
    if (typeof out === "object") {
      const o = out as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length > 0 && keys.every((k) => k === "status" || k === "body" || k === "headers")) {
        const n = o.status;
        const status: ContentfulStatusCode =
          typeof n === "number" && Number.isInteger(n) && n >= 200 && n <= 599
            ? (n as ContentfulStatusCode)
            : 200;
        const body = o.body ?? null;
        const h = (o.headers ?? {}) as Record<string, string>;
        if (body instanceof Response) return body;
        if (typeof body === "string") {
          c.header("Content-Type", h["content-type"] ?? h["Content-Type"] ?? "text/plain; charset=utf-8");
          for (const [k, v] of Object.entries(h)) c.header(k, v);
          return c.text(body, status);
        }
        for (const [k, v] of Object.entries(h)) c.header(k, v);
        return c.json(body, status);
      }
      return c.json(o);
    }
    return c.text(String(out));
  });

  return r;
}
