import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";

function readText(p: string): string | null {
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function docsRoutes(): Hono {
  const r = new Hono();
  // Público y sin sesión a propósito: es documentación estática (sin
  // secretos) y sirve como contexto raw para LLMs externos:
  //   GET /api/docs/plugin-api       → text/markdown raw
  //   GET /api/docs/plugin-api?format=json → { markdown, dts, version }
  r.get("/plugin-api", (c) => {
    const root = process.cwd();
    const markdown =
      readText(path.resolve(root, "docs/plugin-api.md")) ?? "";
    if (!markdown) return c.text("docs no disponibles", 500);
    if (c.req.query("format") === "json") {
      const dts =
        readText(path.resolve(root, "web/src/lib/plugin-api.d.ts")) ?? "";
      return c.json({ markdown, dts, version: "v1" });
    }
    c.header("Content-Type", "text/markdown; charset=utf-8");
    return c.text(markdown);
  });
  return r;
}
