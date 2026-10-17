import fs from "node:fs";
import path from "node:path";

interface ManifestChunk {
  file: string;
  css?: string[];
  imports?: string[];
}

function loadManifest(): Record<string, ManifestChunk> | null {
  const p = path.resolve(process.cwd(), "dist/.vite/manifest.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const VITE_DEV_URL = process.env.VITE_DEV_URL ?? "http://localhost:5173";
const isProd = process.env.NODE_ENV === "production";

function devScripts(): string {
  // Integración backend según docs de Vite: preamble react-refresh + client HMR.
  // Ver https://vite.dev/guide/backend-integration.html
  return `<script type="module">
import RefreshRuntime from "${VITE_DEV_URL}/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script>
<script type="module" src="${VITE_DEV_URL}/@vite/client"></script>
<script type="module" src="${VITE_DEV_URL}/src/main.tsx"></script>`;
}

export function renderShell(bootstrap: unknown): string {
  const manifest = isProd ? loadManifest() : null;
  let scripts = "";
  let styles = "";
  if (manifest) {
    // Entrada: web/src/main.tsx
    const key = Object.keys(manifest).find((k) => k.includes("main.tsx")) ?? Object.keys(manifest)[0];
    const chunk = manifest[key];
    if (chunk) {
      for (const css of chunk.css ?? []) styles += `<link rel="stylesheet" href="/${css}">`;
      scripts += `<script type="module" src="/${chunk.file}"></script>`;
      for (const imp of chunk.imports ?? []) {
        const c = manifest[imp];
        if (c) scripts += `<link rel="modulepreload" href="/${c.file}">`;
      }
    }
  } else {
    // Dev: el :3000 inyecta el cliente HMR del Vite dev server (:5173).
    // Requiere `pnpm dev:web` corriendo en paralelo (o `pnpm dev:all`).
    scripts = devScripts();
  }
  return `<!doctype html>
<html lang="es" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Zyntra Bot — panel de control para tu bot de Discord">
<title>Zyntra Bot · Panel</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
${styles}
</head>
<body>
<div id="root"></div>
<script>window.__BOOTSTRAP__=${JSON.stringify(bootstrap ?? {})}</script>
${scripts}
</body>
</html>`;
}
