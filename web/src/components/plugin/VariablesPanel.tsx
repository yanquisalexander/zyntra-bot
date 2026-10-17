import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Save, Trash2, Variable } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertError } from "@/components/common";
import type { VarTypeName } from "./SettingsForm";

interface DeclaredVar {
  key: string;
  varType: VarTypeName;
  label?: string;
  description?: string;
  hidden?: boolean;
  default?: number | string | boolean;
}

/**
 * Visor de variables del plugin: todas las declaradas con su valor live
 * (editar, reset al default, borrar) + claves guardadas no declaradas.
 */
export function VariablesPanel({
  plugin,
  declared,
  onChanged,
}: {
  plugin: string;
  declared: DeclaredVar[];
  onChanged: () => void;
}) {
  const [vars, setVars] = useState<Record<string, number | string | boolean>>({});
  const [edits, setEdits] = useState<Record<string, number | string | boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const refresh = useCallback(async () => {
    try {
      const d = await api<{ vars: Record<string, number | string | boolean> }>(
        `/api/plugins/${encodeURIComponent(plugin)}/variables`,
      );
      setVars(d.vars ?? {});
      setEdits({});
      setErr("");
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [plugin]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setEdit = (key: string, v: number | string | boolean) =>
    setEdits((prev) => ({ ...prev, [key]: v }));

  const saveAll = async () => {
    if (Object.keys(edits).length === 0) return;
    setSaving(true);
    setErr("");
    try {
      await api(`/api/plugins/${encodeURIComponent(plugin)}/variables`, {
        method: "PUT",
        body: JSON.stringify({ values: edits }),
      });
      onChanged();
      await refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  const resetOne = async (key: string) => {
    setSaving(true);
    setErr("");
    try {
      await api(`/api/plugins/${encodeURIComponent(plugin)}/variables/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      onChanged();
      await refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Skeleton className="h-48 w-full" />;
  // hidden: no se muestra, pero sigue contando como declarada (no sale en "no declaradas").
  const visible = declared.filter((d) => !d.hidden);
  const undeclared = Object.keys(vars).filter((k) => !declared.some((d) => d.key === k));
  if (visible.length === 0 && undeclared.length === 0) {
    return (
      <div className="space-y-3 text-center">
        <p className="font-display text-xl font-semibold tracking-tight">Sin variables todavía</p>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          Declara la primera con <span className="font-mono">type: variable</span> en{" "}
          <span className="font-mono">schema.yml</span> y aparecerá aquí con su valor en directo.
        </p>
      </div>
    );
  }

  const dirtyCount = Object.keys(edits).length;

  return (
    <div className="space-y-3">
      {err && <AlertError message={err} />}
      {visible.map((d) => {
        const live = edits[d.key] !== undefined ? edits[d.key] : vars[d.key] ?? d.default;
        return (
          <Card key={d.key}>
            <CardContent className="flex flex-col gap-2.5 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-extrabold">
                  {d.label || d.key}{" "}
                  <span className="ml-1 font-mono text-[11px] font-normal text-zinc-500">{d.key}</span>
                  <Badge variant="secondary" className="ml-2 font-mono font-normal">
                    {d.varType}
                  </Badge>
                </p>
                {d.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{d.description}</p>
                )}
                <div className="mt-2 max-w-md">
                  <VarEditor varType={d.varType} value={live} onChange={(v) => setEdit(d.key, v)} />
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  title="Volver al default"
                  disabled={saving}
                  onClick={() => resetOne(d.key)}
                >
                  <RotateCcw className="size-3.5" />
                  Reset
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
      {undeclared.length > 0 && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <p className="text-[13px] font-extrabold">
              Guardadas pero no declaradas{" "}
              <span className="font-normal text-muted-foreground">(decláralas en schema.yml para editarlas)</span>
            </p>
            {undeclared.map((k) => (
              <div key={k} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {k} = {JSON.stringify(vars[k])}
                </span>
                <Button variant="ghost" size="xs" title="Borrar valor" disabled={saving} onClick={() => resetOne(k)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={saving || dirtyCount === 0} onClick={saveAll}>
          <Save className="size-4" />
          {saving ? "Guardando…" : `Guardar${dirtyCount > 0 ? ` (${dirtyCount})` : ""}`}
        </Button>
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Variable className="size-3.5" />
          Se guarda en vars.json (no recarga el plugin).
        </p>
      </div>
    </div>
  );
}

function VarEditor({
  varType,
  value,
  onChange,
}: {
  varType: VarTypeName;
  value: number | string | boolean | undefined;
  onChange: (v: number | string | boolean) => void;
}) {
  if (varType === "boolean") {
    return <Switch checked={value === true} onChange={(v) => onChange(v)} />;
  }
  if (varType === "number") {
    return (
      <Input
        type="number"
        className="max-w-48 [color-scheme:dark]"
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? "" as never : Number(e.target.value))}
      />
    );
  }
  return (
    <Input
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
