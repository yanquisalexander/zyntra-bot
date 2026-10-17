import { logger } from "./logger.js";
import type { UiTabDef, UiWidget } from "./types.js";

export interface RegisteredAction {
  plugin: string;
  id: string;
  label: string;
  variant: "default" | "secondary" | "destructive";
  confirm?: string;
  handler: (args: Record<string, unknown>) => unknown;
}

export interface TabListItem extends UiTabDef {
  plugin: string;
}

export type ResolvedWidget =
  | { kind: "stat"; id: string; title?: string; value: string; suffix?: string; icon?: UiTabDef["icon"];   width: "full" | "half"; refreshMs?: number; error?: string }
  | { kind: "table"; id: string; title?: string; columns: { key: string; label: string; mono?: boolean }[]; rows: string[][]; empty?: string;   width: "full" | "half"; refreshMs?: number; error?: string }
  | { kind: "list"; id: string; title?: string; items: string[]; empty?: string;   width: "full" | "half"; refreshMs?: number; error?: string }
  | { kind: "line" | "bars"; id: string; title?: string; series: number[]; empty?: string;   width: "full" | "half"; refreshMs?: number; error?: string }
  | { kind: "text"; id: string; title?: string; text: string;   width: "full" | "half"; refreshMs?: number; error?: string }
  | { kind: "actions"; id: string; title?: string; actions: { id: string; label: string; variant: "default" | "secondary" | "destructive"; confirm?: string }[];   width: "full" | "half"; refreshMs?: number; error?: string };

export interface TabView {
  plugin: string;
  tab: UiTabDef;
  widgets: ResolvedWidget[];
}

const DATA_TIMEOUT_MS = 10_000;
const MAX_CELL = 200;
const MAX_ROWS = 50;
const MAX_POINTS = 120;
const MAX_TEXT = 2000;

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function toText(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  try {
    return JSON.stringify(v) ?? "—";
  } catch {
    return String(v);
  }
}

/** Registro central de UI declarativa. El manager posee una instancia; el teardown limpia por plugin. */
export class UiRegistry {
  private tabs = new Map<string, { plugin: string; def: UiTabDef }>();
  private widgets = new Map<string, { plugin: string; tabId: string; widget: UiWidget }>();
  private dataProviders = new Map<string, { plugin: string; fn: () => unknown }>();
  private actions = new Map<string, RegisteredAction>();

  private tabKey(plugin: string, tabId: string): string {
    return `${plugin}:${tabId}`;
  }

  registerTab(plugin: string, tab: UiTabDef): void {
    const key = this.tabKey(plugin, tab.id);
    if (this.tabs.has(key)) logger.warn(`plugin:${plugin}`, `ui tab "${tab.id}" sobrescrito (evita duplicados)`);
    this.tabs.set(key, { plugin, def: tab });
  }

  unregisterTab(plugin: string, id: string): boolean {
    const prefix = `${this.tabKey(plugin, id)}:`;
    let removed = this.tabs.delete(this.tabKey(plugin, id));
    for (const key of [...this.widgets.keys()]) {
      if (key.startsWith(prefix)) {
        this.widgets.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  hasTab(plugin: string, tabId: string): boolean {
    return this.tabs.has(this.tabKey(plugin, tabId));
  }

  hasWidget(plugin: string, tabId: string, widgetId: string): boolean {
    return this.widgets.has(`${this.tabKey(plugin, tabId)}:${widgetId}`);
  }

  registerWidget(plugin: string, tabId: string, widget: UiWidget): void {
    this.widgets.set(`${this.tabKey(plugin, tabId)}:${widget.id}`, { plugin, tabId, widget });
  }

  registerData(plugin: string, id: string, fn: () => unknown): void {
    this.dataProviders.set(`${plugin}:${id}`, { plugin, fn });
  }

  registerAction(plugin: string, action: Omit<RegisteredAction, "plugin" | "handler"> & { handler: RegisteredAction["handler"] }): void {
    const key = `${plugin}:${action.id}`;
    if (this.actions.has(key)) logger.warn(`plugin:${plugin}`, `ui action "${action.id}" sobrescrito (evita duplicados)`);
    this.actions.set(key, { ...action, plugin });
  }

  unregisterAction(plugin: string, id: string): boolean {
    return this.actions.delete(`${plugin}:${id}`);
  }

  /** Limpieza total del plugin (teardown/reload/unload). */
  removePlugin(plugin: string): void {
    const drop = (m: Map<string, { plugin: string }>) => {
      for (const [key, v] of [...m.entries()]) if (v.plugin === plugin) m.delete(key);
    };
    drop(this.tabs);
    drop(this.widgets);
    drop(this.dataProviders);
    drop(this.actions);
  }

  listTabs(): TabListItem[] {
    return [...this.tabs.values()]
      .map(({ plugin, def }) => ({ ...def, plugin }))
      .sort((a, b) => a.plugin.localeCompare(b.plugin) || a.label.localeCompare(b.label));
  }

  getAction(plugin: string, actionId: string): RegisteredAction | undefined {
    return this.actions.get(`${plugin}:${actionId}`);
  }

  /** Resuelve un tab a JSON renderizable invocando providers con timeout. Nunca lanza. */
  async resolveTab(plugin: string, tabId: string, timeoutMs = DATA_TIMEOUT_MS): Promise<TabView | null> {
    const entry = this.tabs.get(this.tabKey(plugin, tabId));
    if (!entry) return null;
    const widgets: ResolvedWidget[] = [];
    for (const { widget } of [...this.widgets.values()].filter((w) => w.plugin === plugin && w.tabId === tabId)) {
      widgets.push(await this.resolveWidget(plugin, widget, timeoutMs));
    }
    return { plugin, tab: entry.def, widgets };
  }

  private async invoke<T>(plugin: string, dataId: string, timeoutMs: number): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    const p = this.dataProviders.get(`${plugin}:${dataId}`);
    if (!p) return { ok: false, error: `sin datos: "${dataId}" no registrado (api.ui.data)` };
    try {
      const value = await Promise.race([
        p.fn(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout (${timeoutMs}ms)`)), timeoutMs)),
      ]);
      return { ok: true, value };
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 300);
      logger.error(`plugin:${plugin}`, `ui data "${dataId}": ${msg}`);
      return { ok: false, error: msg };
    }
  }

  private async resolveWidget(plugin: string, widget: UiWidget, timeoutMs: number): Promise<ResolvedWidget> {
    const base = {
      id: widget.id,
      title: widget.title,
      width: widget.width ?? ("half" as const),
      refreshMs: widget.refreshMs,
    };
    switch (widget.kind) {
      case "stat": {
        const r = await this.invoke(plugin, widget.data, timeoutMs);
        if (!r.ok) return { ...base, kind: "stat", value: "—", suffix: widget.suffix, icon: widget.icon, error: r.error };
        return { ...base, kind: "stat", value: trunc(toText(r.value), MAX_CELL), suffix: widget.suffix, icon: widget.icon };
      }
      case "table": {
        const r = await this.invoke(plugin, widget.data, timeoutMs);
        if (!r.ok) return { ...base, kind: "table", columns: widget.columns, rows: [], empty: widget.empty, error: r.error };
        const raw = Array.isArray(r.value) ? r.value.slice(0, MAX_ROWS) : [];
        const rows = raw.map((row) =>
          widget.columns.map((c) => {
            const cell = Array.isArray(row)
              ? row[widget.columns.indexOf(c)]
              : (row as Record<string, unknown>)?.[c.key];
            return trunc(toText(cell), MAX_CELL);
          }),
        );
        return { ...base, kind: "table", columns: widget.columns, rows, empty: widget.empty };
      }
      case "list": {
        const r = await this.invoke(plugin, widget.data, timeoutMs);
        if (!r.ok) return { ...base, kind: "list", items: [], empty: widget.empty, error: r.error };
        const items = (Array.isArray(r.value) ? r.value : []).slice(0, MAX_ROWS).map((v) => trunc(toText(v), MAX_CELL));
        return { ...base, kind: "list", items, empty: widget.empty };
      }
      case "line":
      case "bars": {
        const r = await this.invoke(plugin, widget.data, timeoutMs);
        if (!r.ok) return { ...base, kind: widget.kind, series: [], empty: widget.empty, error: r.error };
        const series = (Array.isArray(r.value) ? r.value : [])
          .map(Number)
          .filter(Number.isFinite)
          .slice(-MAX_POINTS);
        return { ...base, kind: widget.kind, series, empty: widget.empty };
      }
      case "text": {
        const r = await this.invoke(plugin, widget.data, timeoutMs);
        if (!r.ok) return { ...base, kind: "text", text: "", error: r.error };
        return { ...base, kind: "text", text: trunc(toText(r.value), MAX_TEXT) };
      }
      case "actions": {
        const actions = widget.items
          .map((id) => this.actions.get(`${plugin}:${id}`))
          .filter((a): a is RegisteredAction => !!a)
          .map((a) => ({ id: a.id, label: a.label, variant: a.variant, confirm: a.confirm }));
        if (actions.length === 0) {
          return { ...base, kind: "actions", actions, error: "sin acciones válidas" };
        }
        return { ...base, kind: "actions", actions };
      }
    }
  }
}
