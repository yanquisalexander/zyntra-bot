import { Hono } from "hono";
import { requireAdmin } from "../session.js";
import { getLogs, onLog, type LogEntry } from "../../plugins/logger.js";

export function logsRoutes(manager: { list(): unknown }): Hono {
  const r = new Hono();
  r.use("*", requireAdmin);

  r.get("/", (c) => {
    const since = c.req.query("since");
    const limit = Math.min(Number(c.req.query("limit") ?? 200), 500);
    return c.json({ logs: getLogs(since, limit) });
  });

  r.get("/stream", (c) => {
    let onEntry: ((e: LogEntry) => void) | null = null;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (e: LogEntry) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        onEntry = send;
        const off = onLog(send);
        // Cierra a los 5 min para no colgar conexiones eternas.
        setTimeout(() => {
          off();
          try {
            controller.close();
          } catch {
            /* noop */
          }
        }, 5 * 60 * 1000);
      },
      cancel() {
        void onEntry;
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  });

  return r;
}
