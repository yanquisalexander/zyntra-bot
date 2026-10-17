import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import EditorMonaco, { type BeforeMount } from "@monaco-editor/react";
import { ArrowLeft, Braces, CheckCircle2, FileCode2, History, RotateCcw, Save, Settings2, SlidersHorizontal, Sparkles, Tag, Trash2, TriangleAlert, Variable, Zap } from "lucide-react";
import { api, createRevision, deleteRevision, getRevision, listRevisions, restoreRevision, type PluginRevision, type PluginRevisionFull } from "@/lib/api";
import { DEFAULT_AI_MODEL } from "@/lib/ai-companion/models";
import { AiCompanionPanel } from "@/components/plugin/AiCompanionPanel";
import { cn } from "@/lib/utils";
import pluginApiLib from "@/lib/plugin-api.d.ts?raw";
import { Button } from "@/components/ui/button";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { PageHeader, AlertError, StatusBadge, statusText } from "@/components/common";
import {
  SettingsForm,
  type SchemaCategory,
  type SchemaField,
  type SettingsFormHandle,
} from "@/components/plugin/SettingsForm";
import { VariablesPanel } from "@/components/plugin/VariablesPanel";

type Tab = "code" | "settings" | "variables" | "schema" | "config" | "history";

// La lib extra es global a Monaco: se re-registra de forma idempotente
// (dispose previo) para sobrevivir a StrictMode/HMR sin duplicados.
let pluginApiDispose: { dispose(): void } | null = null;

const setupPluginIntelliSense: BeforeMount = (monaco) => {
  const js = monaco.languages.typescript.javascriptDefaults;
  js.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    allowJs: true,
    // checkJs off: autocompletado + hover sí, pero sin subrayar
    // en rojo el código válido (los objetos de discord.js son permisivos).
    checkJs: false,
    strict: false,
    allowNonTsExtensions: true,
  });
  pluginApiDispose?.dispose();
  pluginApiDispose = js.addExtraLib(pluginApiLib, "zyntra-plugin-api.d.ts");
};

export default function PluginEditor() {
  const { name } = useParams<{ name: string }>();
  const [tab, setTab] = useState<Tab>("code");
  const [code, setCode] = useState("// cargando…");
  const [toml, setToml] = useState("");
  const [configJson, setConfigJson] = useState<Record<string, unknown>>({});
  const [schemaRaw, setSchemaRaw] = useState("");
  const [schema, setSchema] = useState<{ fields: SchemaField[]; categories: SchemaCategory[] } | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [lastError, setLastError] = useState("");
  const [core, setCore] = useState(false);
  const [msg, setMsg] = useState("");
  const [msgKind, setMsgKind] = useState<"ok" | "err" | "info">("info");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirtyCode, setDirtyCode] = useState(false);
  const [dirtyToml, setDirtyToml] = useState(false);
  const [dirtySchema, setDirtySchema] = useState(false);
  const [dirtySettings, setDirtySettings] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiModel, setAiModel] = useState<string>(DEFAULT_AI_MODEL);
  // Override solo de este navegador (no toca el ajuste global).
  const [aiModelLocal, setAiModelLocal] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem("zyntra:ai-model");
    } catch {
      return null;
    }
  });
  const effectiveAiModel = aiModelLocal ?? aiModel;
  const changeAiModelLocal = (id: string) => {
    setAiModelLocal(id);
    try {
      window.localStorage.setItem("zyntra:ai-model", id);
    } catch {
      /* noop */
    }
  };
  const [showAi, setShowAi] = useState(false);
  const formRef = useRef<SettingsFormHandle>(null);

  // ─── VCS: estado del historial ──────────────────────────────────────────
  const [revisions, setRevisions] = useState<PluginRevision[]>([]);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [selectedRev, setSelectedRev] = useState<PluginRevisionFull | null>(null);
  const [selectedRevLoading, setSelectedRevLoading] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [snapshotSaving, setSnapshotSaving] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [deletingRev, setDeletingRev] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!name) return;
    setLoading(true);
    try {
      const d = await api<{
        code: string;
        config: string;
        configJson?: Record<string, unknown>;
        schemaRaw?: string;
        schema?: { fields: SchemaField[]; categories: SchemaCategory[] } | null;
        schemaError?: string | null;
        vars?: Record<string, unknown>;
        status: string;
        displayName?: string;
        lastError?: string;
        core?: boolean;
      }>(`/api/plugins/${encodeURIComponent(name)}`);
      setCode(d.code);
      setToml(d.config);
      setConfigJson(d.configJson ?? {});
      setSchemaRaw(d.schemaRaw ?? "");
      setSchema(d.schema ?? null);
      setSchemaError(d.schemaError ?? null);
      setStatus(d.status);
      setDisplayName(d.displayName || name || "");
      setLastError(d.lastError ?? "");
      setCore(d.core ?? false);
      setDirtyCode(false);
      setDirtyToml(false);
      setDirtySchema(false);
      setDirtySettings(false);
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
      setMsgKind("err");
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    load();
  }, [load]);

  const loadRevisions = useCallback(async () => {
    if (!name) return;
    setRevisionsLoading(true);
    try {
      setRevisions(await listRevisions(name));
    } catch {
      /* noop */
    } finally {
      setRevisionsLoading(false);
    }
  }, [name]);

  useEffect(() => {
    if (tab === "history") loadRevisions();
  }, [tab, loadRevisions]);

  useEffect(() => {
    api<{ config: Record<string, unknown> }>("/api/config")
      .then((d) => {
        setAiEnabled(d.config.aiCompanionEnabled === true);
        if (typeof d.config.aiCompanionModel === "string" && d.config.aiCompanionModel) {
          setAiModel(d.config.aiCompanionModel);
        }
      })
      .catch(() => undefined);
  }, []);

  const say = (m: string, k: "ok" | "err" | "info" = "info") => {
    setMsg(m);
    setMsgKind(k);
  };

  const saveSettings = async (values: Record<string, unknown>): Promise<boolean> => {
    if (!name) return false;
    setSaving(true);
    say("Guardando ajustes…");
    try {
      // Aquí solo llegan ajustes de config.toml (las variables viven
      // en su propia pestaña y su propio store: no recargan).
      await api(`/api/plugins/${encodeURIComponent(name)}/settings`, {
        method: "PUT",
        body: JSON.stringify({ values }),
      });
      setDirtySettings(false);
      say("Ajustes guardados ✓ — recarga el plugin para aplicarlos", "ok");
      await load();
      return true;
    } catch (e) {
      say(String(e instanceof Error ? e.message : e), "err");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const generateSchema = async () => {
    if (!name) return;
    setSaving(true);
    say("Generando formulario…");
    try {
      await api(`/api/plugins/${encodeURIComponent(name)}/schema/generate`, { method: "POST" });
      say("Formulario creado ✓ — míralo en schema.yml", "ok");
      await load();
    } catch (e) {
      say(String(e instanceof Error ? e.message : e), "err");
    } finally {
      setSaving(false);
    }
  };

  const save = async (which: Tab): Promise<boolean> => {
    if (!name) return false;
    if (which === "settings") {
      return (await formRef.current?.save()) ?? false;
    }
    if (which === "variables") {
      await load();
      say("Valores actualizados ✓", "ok");
      return true;
    }
    setSaving(true);
    say("Guardando…");
    try {
      if (which === "code") {
        await api(`/api/plugins/${encodeURIComponent(name)}/code`, {
          method: "PUT",
          body: JSON.stringify({ code }),
        });
        setDirtyCode(false);
      } else if (which === "schema") {
        await api(`/api/plugins/${encodeURIComponent(name)}/schema`, {
          method: "PUT",
          body: JSON.stringify({ raw: schemaRaw }),
        });
        setDirtySchema(false);
        await load();
      } else {
        await api(`/api/plugins/${encodeURIComponent(name)}/config`, {
          method: "PUT",
          body: JSON.stringify({ toml }),
        });
        setDirtyToml(false);
      }
      say("Guardado ✓", "ok");
      return true;
    } catch (e) {
      say(String(e instanceof Error ? e.message : e), "err");
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Core: sin subida de código (403). Guarda ajustes si los hay y recarga. */
  const reloadOnly = async () => {
    if (!name) return;
    setSaving(true);
    try {
      if (tab === "settings" && dirtySettings) {
        if (!(await save("settings"))) return;
      }
      say("Aplicando cambios…");
      await api(`/api/plugins/${encodeURIComponent(name)}/reload`, { method: "POST" });
      say("Listo ✓ — el bot siguió funcionando", "ok");
      await load();
    } catch (e) {
      say(String(e instanceof Error ? e.message : e), "err");
    } finally {
      setSaving(false);
    }
  };

  const saveReload = async () => {
    if (!name) return;
    setSaving(true);
    try {
      // Persiste la pestaña visible (código, schema, config, ajustes o
      // variables): antes solo se guardaba el código y el schema.yml,
      // por ejemplo, se perdía al recargar.
      if (!(await save(tab))) return;
      say("Revisando el código…");
      const v = await api<{ ok: boolean; error?: string }>(
        `/api/plugins/${encodeURIComponent(name)}/validate`,
        { method: "POST" },
      ).catch((e) => ({ ok: false, error: String(e instanceof Error ? e.message : e) }));
      if (!v.ok) {
        say(`Hay un error en el código: ${v.error}`, "err");
        return;
      }
      say("Aplicando cambios…");
      await api(`/api/plugins/${encodeURIComponent(name)}/reload`, { method: "POST" });
      say("Listo ✓ — el bot siguió funcionando", "ok");
      await load();
    } catch (e) {
      say(String(e instanceof Error ? e.message : e), "err");
    } finally {
      setSaving(false);
    }
  };

  const dirty = dirtyCode || dirtyToml || dirtySchema || dirtySettings;

  const tabOptions: SegmentedOption<Tab>[] = (
    [
      { value: "code", label: "plugin.js", icon: <FileCode2 className="size-4" />, dot: dirtyCode },
      { value: "settings", label: "Ajustes", icon: <SlidersHorizontal className="size-4" />, dot: dirtySettings },
      { value: "variables", label: "Variables", icon: <Variable className="size-4" /> },
      { value: "schema", label: "schema.yml", icon: <Braces className="size-4" />, dot: dirtySchema },
      { value: "config", label: "config.toml", icon: <Settings2 className="size-4" />, dot: dirtyToml },
      { value: "history", label: "Historial", icon: <History className="size-4" /> },
    ] as SegmentedOption<Tab>[]
  ).filter((t) => !core || t.value === "settings" || t.value === "variables" || t.value === "history");

  // Core: sin pestañas de código — si se cae en una, volver a Ajustes.
  useEffect(() => {
    if (core && (tab === "code" || tab === "schema" || tab === "config")) setTab("settings");
  }, [core, tab]);

  const varFields = (schema?.fields ?? []).filter((f) => f.type === "variable");

  const showAiPanel = aiEnabled && !core && tab === "code" && showAi;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Editar ${displayName || name || "plugin"}`}
        description={
          status
            ? `Estado: ${statusText(status)}${core ? " · Plugin core: ajustable, no editable." : ""}`
            : "Edita el código y los ajustes del plugin."
        }
        actions={
          <Link to="/plugins">
            <Button variant="outline" size="sm">
              <ArrowLeft className="size-4" />
              Plugins
            </Button>
          </Link>
        }
      />

      {/* Barra de estado */}
      <div className="flex flex-wrap items-center gap-2">
        {status && <StatusBadge status={status} />}
        {core && (
          <Badge variant="secondary" title="Viene con la app: solo ajustes y activar/desactivar">
            Core
          </Badge>
        )}
        {name && (
          <Badge variant="outline" className="font-mono" title="Identificador: la carpeta del plugin">
            {name}
          </Badge>
        )}
        {dirty && (
          <Badge variant="warning">
            <span className="size-1.5 rounded-full bg-[#ffb700]" />
            sin guardar
          </Badge>
        )}
        {lastError && (
          <span className="max-w-full truncate rounded-lg border border-[#ff5e5b33] bg-[#ff5e5b11] px-2.5 py-1 font-mono text-[11px] text-[#ff7a78]">
            {lastError.slice(0, 220)}
          </span>
        )}
      </div>

      {/* Toolbar */}
      <Card>
        <CardContent className="flex flex-col gap-2.5 p-3 sm:flex-row sm:items-center">
          <Segmented
            ariaLabel="Archivo del plugin"
            value={tab}
            onChange={setTab}
            options={tabOptions}
          />
          <div className="flex flex-1 flex-wrap items-center gap-2 sm:justify-end">
            {msg && (
              <span
                className={cn(
                  "mr-auto flex min-w-0 items-center gap-1.5 text-[13px] sm:mr-2",
                  msgKind === "ok" ? "text-[#00d4aa]" : msgKind === "err" ? "text-[#ff7a78]" : "text-[#ffb700]",
                )}
              >
                {msgKind === "ok" ? (
                  <CheckCircle2 className="size-4 shrink-0" />
                ) : msgKind === "err" ? (
                  <TriangleAlert className="size-4 shrink-0" />
                ) : null}
                <span className="min-w-0 flex-1 truncate sm:max-w-[420px]">{msg}</span>
              </span>
            )}
            {core ? (
              <Button
                size="sm"
                disabled={saving || loading}
                onClick={reloadOnly}
                title="Recarga el plugin para aplicar los ajustes guardados"
              >
                <Zap className="size-4" />
                {saving ? "Trabajando…" : "Recargar"}
              </Button>
            ) : (
              <>
                <Button variant="secondary" size="sm" disabled={saving || loading} onClick={() => save(tab)}>
                  <Save className="size-4" />
                  Guardar
                </Button>
                {aiEnabled && tab === "code" && (
                  <Button
                    variant={showAi ? "default" : "outline"}
                    size="sm"
                    onClick={() => setShowAi((v) => !v)}
                    title="AI-Companion experimental (WebLLM local)"
                  >
                    <Sparkles className="size-4" />
                    AI
                  </Button>
                )}
                <Button size="sm" disabled={saving || loading} onClick={saveReload}>
                  <Zap className="size-4" />
                  {saving ? "Trabajando…" : "Guardar y recargar"}
                </Button>
              </>
            )}
          </div>
        </CardContent>
        {saving && (
          <div className="h-1 overflow-hidden rounded-b-xl bg-primary/15" role="progressbar" aria-label="Guardando">
            <div className="h-full w-2/5 rounded-full bg-primary animate-linear-slide" />
          </div>
        )}
      </Card>

      {msgKind === "err" && msg && <AlertError message={msg} />}

      {/* Contenido: formulario, variables, historial o Monaco */}
      {tab === "variables" ? (
        <Card>
          <CardContent className="p-6">
            {loading ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              <VariablesPanel
                plugin={name ?? ""}
                declared={varFields.map((f) => ({
                  key: f.key,
                  varType: f.varType ?? "string",
                  label: f.label,
                  description: f.description,
                  hidden: f.hidden,
                  default:
                    typeof f.default === "number" ||
                    typeof f.default === "string" ||
                    typeof f.default === "boolean"
                      ? f.default
                      : undefined,
                }))}
                onChanged={() => load()}
              />
            )}
          </CardContent>
        </Card>
      ) : tab === "settings" ? (
        <Card>
          <CardContent className="p-6">
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : schemaError ? (
              <div className="space-y-3">
                <AlertError message={schemaError} />
                <p className="text-sm text-muted-foreground">
                  El formulario no se puede pintar hasta que el archivo esté bien. Arréglalo en la
                  pestaña <span className="font-mono">schema.yml</span>.
                </p>
                <Button variant="secondary" size="sm" onClick={() => setTab("schema")}>
                  Abrir schema.yml
                </Button>
              </div>
            ) : !schema || schema.fields.filter((f) => f.type !== "variable").length === 0 ? (
              varFields.length > 0 ? (
                <div className="space-y-3 text-center">
                  <p className="font-display text-xl font-semibold tracking-tight">Aquí no hay ajustes</p>
                  <p className="mx-auto max-w-md text-sm text-muted-foreground">
                    Este plugin solo declara variables, y viven en su propia pestaña.
                  </p>
                  <Button variant="secondary" size="sm" onClick={() => setTab("variables")}>
                    Ir a Variables
                  </Button>
                </div>
              ) : (
                <div className="space-y-3 text-center">
                  <p className="font-display text-xl font-semibold tracking-tight">Sin formulario todavía</p>
                  <p className="mx-auto max-w-md text-sm text-muted-foreground">
                    Este plugin no declara ajustes. Genera un <span className="font-mono">schema.yml</span> desde
                    su config actual, o escríbelo a mano (solo se edita como archivo).
                  </p>
                  <Button size="sm" disabled={saving} onClick={generateSchema}>
                    <SlidersHorizontal className="size-4" />
                    Generar desde la config actual
                  </Button>
                </div>
              )
            ) : (
              <SettingsForm
                ref={formRef}
                fields={schema.fields.filter((f) => f.type !== "variable")}
                categories={schema.categories}
                current={configJson}
                saving={saving}
                onSave={saveSettings}
                onDirty={setDirtySettings}
              />
            )}
          </CardContent>
        </Card>
      ) : tab === "history" ? (
        <div className="space-y-4">
          {/* Guardar punto manual */}
          <Card>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Etiqueta opcional
                </label>
                <Input
                  placeholder="ej: antes del refactor, versión estable…"
                  value={snapshotLabel}
                  onChange={(e) => setSnapshotLabel(e.target.value)}
                  disabled={snapshotSaving}
                  className="h-8 text-sm"
                />
              </div>
              <Button
                size="sm"
                disabled={snapshotSaving || loading}
                onClick={async () => {
                  if (!name) return;
                  setSnapshotSaving(true);
                  try {
                    await createRevision(name, snapshotLabel || undefined);
                    setSnapshotLabel("");
                    say("Punto de restauración guardado ✓", "ok");
                    await loadRevisions();
                  } catch (e) {
                    say(String(e instanceof Error ? e.message : e), "err");
                  } finally {
                    setSnapshotSaving(false);
                  }
                }}
              >
                <Tag className="size-4" />
                {snapshotSaving ? "Guardando…" : "Guardar punto ahora"}
              </Button>
            </CardContent>
          </Card>

          {/* Lista de revisiones */}
          <Card>
            <CardContent className="divide-y divide-border p-0">
              {revisionsLoading ? (
                <div className="space-y-2 p-4">
                  {[...Array(3)].map((_, i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              ) : revisions.length === 0 ? (
                <div className="flex flex-col items-center gap-2 p-8 text-center text-muted-foreground">
                  <History className="size-8 opacity-30" />
                  <p className="text-sm">Aún no hay revisiones.</p>
                  <p className="text-xs opacity-70">
                    Se guardan automáticamente al editar el código o la config.
                  </p>
                </div>
              ) : (
                revisions.map((rev) => (
                  <div
                    key={rev.id}
                    className={cn(
                      "flex flex-col gap-2 p-4 transition-colors sm:flex-row sm:items-start",
                      selectedRev?.id === rev.id && "bg-muted/40",
                    )}
                  >
                    <div className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1" onClick={async () => {
                      if (selectedRev?.id === rev.id) { setSelectedRev(null); return; }
                      setSelectedRevLoading(true);
                      try {
                        setSelectedRev(await getRevision(name ?? "", rev.id));
                      } catch {
                        /* noop */
                      } finally {
                        setSelectedRevLoading(false);
                      }
                    }}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{rev.id.slice(0, 8)}</span>
                        {rev.label && (
                          <Badge variant="secondary" className="gap-1 text-xs">
                            <Tag className="size-3" />
                            {rev.label}
                          </Badge>
                        )}
                        {rev.orphan && (
                          <Badge variant="warning" className="text-xs">
                            <TriangleAlert className="size-3" />
                            plugin eliminado
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{new Date(rev.createdAt).toLocaleString()}</span>
                        {rev.createdBy && <span>· por {rev.createdBy}</span>}
                        {rev.codePreview && (
                          <span className="hidden truncate font-mono opacity-50 sm:block sm:max-w-[260px]">
                            · {rev.codePreview.replace(/\s+/g, " ").trim()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant={rev.orphan ? "default" : "secondary"}
                        disabled={restoring === rev.id}
                        title={rev.orphan ? "Restaurar y recargar plugin eliminado" : "Restaurar a este estado"}
                        onClick={async () => {
                          if (!name) return;
                          const label = rev.label ? `"${rev.label}"` : rev.id.slice(0, 8);
                          if (!window.confirm(`¿Restaurar el plugin al estado ${label}? El estado actual se guardará como nueva revisión.`)) return;
                          setRestoring(rev.id);
                          try {
                            await restoreRevision(name, rev.id);
                            say(`Restaurado a ${label} ✓ — recargado en caliente`, "ok");
                            await Promise.all([load(), loadRevisions()]);
                          } catch (e) {
                            say(String(e instanceof Error ? e.message : e), "err");
                          } finally {
                            setRestoring(null);
                          }
                        }}
                      >
                        <RotateCcw className="size-4" />
                        {restoring === rev.id ? "Restaurando…" : rev.orphan ? "Restaurar plugin" : "Restaurar"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={deletingRev === rev.id}
                        title="Eliminar esta revisión"
                        onClick={async () => {
                          if (!name) return;
                          if (!window.confirm("¿Eliminar esta revisión? No se puede deshacer.")) return;
                          setDeletingRev(rev.id);
                          try {
                            await deleteRevision(name, rev.id);
                            if (selectedRev?.id === rev.id) setSelectedRev(null);
                            await loadRevisions();
                          } catch (e) {
                            say(String(e instanceof Error ? e.message : e), "err");
                          } finally {
                            setDeletingRev(null);
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>

                    {/* Detalle expandido: código, config y schema de la revisión */}
                    {selectedRev?.id === rev.id && (
                      <div className="col-span-full mt-2 w-full space-y-2">
                        {selectedRevLoading ? (
                          <Skeleton className="h-32 w-full" />
                        ) : (
                          <div className="grid gap-2 sm:grid-cols-3">
                            <div className="space-y-1">
                              <p className="text-xs font-medium text-muted-foreground">plugin.js</p>
                              <pre className="max-h-48 overflow-auto rounded-lg bg-[#1e1e1e] p-3 font-mono text-[11px] text-[#d4d4d4]">
                                {selectedRev.code}
                              </pre>
                            </div>
                            <div className="space-y-1">
                              <p className="text-xs font-medium text-muted-foreground">config.toml</p>
                              <pre className="max-h-48 overflow-auto rounded-lg bg-[#1e1e1e] p-3 font-mono text-[11px] text-[#d4d4d4]">
                                {selectedRev.configToml || "(vacío)"}
                              </pre>
                            </div>
                            <div className="space-y-1">
                              <p className="text-xs font-medium text-muted-foreground">schema.yml</p>
                              <pre className="max-h-48 overflow-auto rounded-lg bg-[#1e1e1e] p-3 font-mono text-[11px] text-[#d4d4d4]">
                                {selectedRev.schemaYml || "(vacío)"}
                              </pre>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Las revisiones se guardan automáticamente al editar código o config, y se eliminan tras 14 días.
            Los plugins eliminados desde el FS (no desde la UI) aparecen marcados como "plugin eliminado"
            y pueden restaurarse.
          </p>
        </div>
      ) : (
        <div className={showAiPanel ? "grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]" : "min-w-0 space-y-4"}>
          <Card className="min-w-0 overflow-hidden">
          {loading ? (
            <Skeleton className="h-[60vh] w-full rounded-none" />
          ) : tab === "code" ? (
            <EditorMonaco
              height="60vh"
              language="javascript"
              theme="vs-dark"
              beforeMount={setupPluginIntelliSense}
              value={code}
              onChange={(v) => {
                setCode(v ?? "");
                setDirtyCode(true);
              }}
              options={{
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 13.5,
                fontFamily: "'JetBrains Mono', monospace",
                padding: { top: 12 },
                scrollBeyondLastLine: false,
                tabSize: 2,
                stickyScroll: { enabled: false },
              }}
            />
          ) : tab === "schema" ? (
            <EditorMonaco
              height="60vh"
              language="yaml"
              theme="vs-dark"
              value={schemaRaw}
              onChange={(v) => {
                setSchemaRaw(v ?? "");
                setDirtySchema(true);
              }}
              options={{
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 13.5,
                fontFamily: "'JetBrains Mono', monospace",
                padding: { top: 12 },
                scrollBeyondLastLine: false,
                tabSize: 2,
                stickyScroll: { enabled: false },
              }}
            />
          ) : (
            <EditorMonaco
              height="60vh"
              language="ini"
              theme="vs-dark"
              value={toml}
              onChange={(v) => {
                setToml(v ?? "");
                setDirtyToml(true);
              }}
              options={{
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 13.5,
                fontFamily: "'JetBrains Mono', monospace",
                padding: { top: 12 },
                scrollBeyondLastLine: false,
                tabSize: 2,
                stickyScroll: { enabled: false },
              }}
            />
          )}
          </Card>
          {showAiPanel && (
            <AiCompanionPanel
              pluginName={name ?? ""}
              code={code}
              lastError={lastError}
              schemaRaw={schemaRaw}
              toml={toml}
              model={effectiveAiModel}
              onModelChange={changeAiModelLocal}
              onApplyFile={(path, content) => {
                if (path === "plugin.js") {
                  setCode(content);
                  setDirtyCode(true);
                } else if (path === "config.toml") {
                  setToml(content);
                  setDirtyToml(true);
                } else {
                  setSchemaRaw(content);
                  setDirtySchema(true);
                }
                say(`Aplicado ${path} — revisa y guarda`, "info");
              }}
            />
          )}
        </div>
      )}

      {tab === "config" ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Al guardar aquí el plugin se recarga solo con la nueva config ✨ — sin botón. Las tareas
          programadas conservan su horario pendiente. Si algo falla, verás el aviso aquí arriba y en los logs.
        </p>
      ) : tab === "history" ? null : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Al guardar y recargar, revisamos el código y aplicamos los cambios sin apagar el bot. Si algo
          falla, verás el aviso aquí arriba y en los logs.
        </p>
      )}
    </div>
  );
}
