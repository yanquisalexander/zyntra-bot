import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { PLUGINS_DIR } from "./store.js";
import { logger } from "./logger.js";
import type { PluginManager } from "./manager.js";

/**
 * Recarga automática al cambiar config.toml (con debounce).
 *
 * - Solo reacciona a `change` (no a `add`: un plugin nuevo se activa a mano).
 * - Solo si el plugin está cargado o con error (si está apagado, la config
 *   nueva se leerá al encender/arrancar, como siempre).
 * - `manager.reload()` valida antes y conserva la versión activa si falla,
 *   así que un guardado a medias nunca tumba el plugin.
 */
export function startConfigWatcher(manager: PluginManager): FSWatcher {
  const pending = new Map<string, NodeJS.Timeout>();

  const watcher = watch(PLUGINS_DIR, {
    depth: 2,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
    ignored: (p: string, stats?: { isFile(): boolean }) => {
      const base = path.basename(p);
      if (base.startsWith(".")) return true;
      if (stats?.isFile() && base !== "config.toml") return true;
      return false;
    },
  });

  watcher.on("change", (file: string) => {
    const name = path.basename(path.dirname(file));
    if (!name) return;
    const prev = pending.get(name);
    if (prev) clearTimeout(prev);
    pending.set(
      name,
      setTimeout(() => {
        pending.delete(name);
        void manager.reloadIfLoaded(name);
      }, 500),
    );
  });

  watcher.on("error", (e: unknown) => {
    logger.error("server", `watcher config: ${String(e)}`);
  });

  return watcher;
}
