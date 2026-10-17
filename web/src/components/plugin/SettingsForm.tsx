import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { Save, Eye, EyeOff } from "lucide-react";
import { Input, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export type SettingType = "string" | "text" | "number" | "boolean" | "select" | "role" | "role_list" | "variable" | "secret";

export type VarTypeName = "number" | "string" | "boolean";

export interface SchemaField {
  key: string;
  type: SettingType;
  label?: string;
  description?: string;
  category?: string;
  default?: unknown;
  options?: string[];
  required?: boolean;
  min?: number;
  max?: number;
  varType?: VarTypeName;
  hidden?: boolean;
}

export interface SchemaCategory {
  name: string;
  description?: string;
}

export interface SettingsFormHandle {
  /** Guarda y dice si fue bien (para "Guardar y recargar"). */
  save: () => Promise<boolean>;
}

function labelOf(f: SchemaField): string {
  return f.label || f.key;
}

function initialValues(
  fields: SchemaField[],
  current: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.key in current) out[f.key] = current[f.key];
    else if (f.default !== undefined) out[f.key] = f.default;
    else if (f.type === "boolean") out[f.key] = false;
    else if (f.type === "role_list") out[f.key] = [];
    else out[f.key] = "";
  }
  return out;
}

interface DiscordRole {
  id: string;
  name: string;
  color: string;
  position: number;
  managed: boolean;
}

// Caché a nivel módulo: N campos `role` = 1 sola petición.
let rolesPromise: Promise<{ guildName: string; roles: DiscordRole[] }> | null = null;

function fetchRoles(): Promise<{ guildName: string; roles: DiscordRole[] }> {
  if (!rolesPromise) {
    rolesPromise = api<{ guild: { name: string }; roles: DiscordRole[] }>("/api/discord/roles").then((d) => ({
      guildName: d.guild.name,
      roles: d.roles,
    }));
    // Si falla, se permite reintentar la próxima vez.
    rolesPromise.catch(() => {
      rolesPromise = null;
    });
  }
  return rolesPromise;
}

function useRoles(enabled: boolean) {
  const [roles, setRoles] = useState<DiscordRole[] | null>(null);
  const [guildName, setGuildName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetchRoles().then(
      (d) => {
        if (!alive) return;
        setRoles(d.roles);
        setGuildName(d.guildName);
      },
      (e) => {
        if (!alive) return;
        setError(String(e instanceof Error ? e.message : e));
      },
    );
    return () => {
      alive = false;
    };
  }, [enabled]);

  return { roles, guildName, rolesError: error };
}

const selectClass =
  "h-10 w-full max-w-md rounded-xl border border-input bg-[#1a1a1a] px-3 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [color-scheme:dark]";

/**
 * Formulario generado desde schema.yml, agrupado por categoría.
 * Los valores se guardan en config.toml (los comentarios se pierden;
 * para conservarlos edita config.toml como archivo).
 */
export const SettingsForm = forwardRef<
  SettingsFormHandle,
  {
    fields: SchemaField[];
    categories: SchemaCategory[];
    current: Record<string, unknown>;
    saving: boolean;
    onSave: (values: Record<string, unknown>) => Promise<boolean>;
    onDirty: (dirty: boolean) => void;
  }
>(function SettingsForm({ fields, categories, current, saving, onSave, onDirty }, ref) {
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(fields, current));
  const currentJson = JSON.stringify(current);

  useEffect(() => {
    setValues(initialValues(fields, JSON.parse(currentJson) as Record<string, unknown>));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentJson]);

  const dirty = useMemo(
    () =>
      JSON.stringify(values) !==
      JSON.stringify(initialValues(fields, JSON.parse(currentJson) as Record<string, unknown>)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values, currentJson],
  );

  useEffect(() => {
    onDirty(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const save = async () => {
    try {
      return (await onSave(values)) !== false;
    } catch {
      return false;
    }
  };
  useImperativeHandle(ref, () => ({ save }), [values, onSave]);

  const set = (key: string, v: unknown) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  const catDesc = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) if (c.description) m.set(c.name, c.description);
    return m;
  }, [categories]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const byCat = new Map<string, SchemaField[]>();
    // hidden: no se muestra, pero su valor se conserva y se guarda igual.
    for (const f of fields.filter((f) => !f.hidden)) {
      const cat = f.category?.trim() || "General";
      if (!byCat.has(cat)) {
        byCat.set(cat, []);
        order.push(cat);
      }
      byCat.get(cat)!.push(f);
    }
    return order.map((cat) => ({ cat, fields: byCat.get(cat)! }));
  }, [fields]);

  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.cat}>
          <h3 className="font-display text-lg font-semibold tracking-tight">{g.cat}</h3>
          {catDesc.get(g.cat) && (
            <p className="mt-0.5 text-[13px] text-muted-foreground">{catDesc.get(g.cat)}</p>
          )}
          <div className="mt-3 space-y-4">
            {g.fields.map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1 block text-[13px] font-extrabold">
                  {labelOf(f)}
                  {f.required && <span className="ml-1 text-[#ff7a78]">*</span>}
                  <span className="ml-2 font-mono text-[11px] font-normal text-zinc-500">{f.key}</span>
                </span>
                {f.description && (
                  <span className="mb-1.5 block text-xs text-muted-foreground">{f.description}</span>
                )}
                <FieldInput field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
              </label>
            ))}
          </div>
        </section>
      ))}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button size="sm" disabled={saving || !dirty} onClick={save}>
          <Save className="size-4" />
          {saving ? "Guardando…" : "Guardar ajustes"}
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Se guarda en <span className="font-mono">config.toml</span> (sin comentarios).
        </p>
      </div>
    </div>
  );
});

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: SchemaField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (field.type) {
    case "text":
      return (
        <Textarea
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
        />
      );
    case "number":
      return (
        <Input
          type="number"
          className="max-w-48 [color-scheme:dark]"
          value={typeof value === "number" ? value : (value as string) ?? ""}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        />
      );
    case "boolean":
      return (
        <Switch checked={value === true} onChange={(v) => onChange(v)} />
      );
    case "select":
      return (
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className={selectClass}
        >
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "role":
      return <RolePicker value={typeof value === "string" ? value : ""} required={field.required} onChange={onChange} />;
    case "role_list": {
      const arr = Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
      return <RoleListPicker value={arr} onChange={onChange} />;
    }
    case "secret":
      return <SecretInput value={typeof value === "string" ? value : ""} onChange={onChange} />;
    default:
      return (
        <Input
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={typeof field.default === "string" ? field.default : undefined}
        />
      );
  }
}

/** Texto enmascarado (claves, tokens) con botón para revelar. */
function SecretInput({ value, onChange }: { value: string; onChange: (v: unknown) => void }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex max-w-md items-center gap-2">
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="••••••••"
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
      />
      <Button
        type="button"
        variant="secondary"
        onClick={() => setVisible((v) => !v)}
        title={visible ? "Ocultar" : "Revelar"}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  );
}

function RoleDot({ color }: { color: string }) {
  const bg = color && color !== "#000000" ? color : "#6b655a";
  return <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: bg }} />;
}

/** Un rol del servidor. Si el bot está desconectado, deja pegar el ID a mano. */
function RolePicker({
  value,
  required,
  onChange,
}: {
  value: string;
  required?: boolean;
  onChange: (v: unknown) => void;
}) {
  const { roles, guildName, rolesError } = useRoles(true);

  if (!roles) {
    if (rolesError) {
      return (
        <div className="max-w-md space-y-1.5">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="ID del rol (pegar a mano)"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">{rolesError} — pega el ID a mano.</p>
        </div>
      );
    }
    return (
      <select disabled className={selectClass}>
        <option>Cargando roles…</option>
      </select>
    );
  }

  const selected = roles.find((r) => r.id === value);
  return (
    <div className="max-w-md space-y-1.5">
      <div className="flex items-center gap-2">
        {selected && <RoleDot color={selected.color} />}
        <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
          {!required && <option value="">Sin rol</option>}
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              @{r.name}
            </option>
          ))}
        </select>
      </div>
      <p className="font-mono text-[11px] text-zinc-500">
        {selected ? `${selected.id} · ${guildName}` : value ? `${value} (fuera del servidor)` : guildName}
      </p>
    </div>
  );
}

/** Varios roles (checkboxes). Se guarda como array en config.toml. */
function RoleListPicker({ value, onChange }: { value: string[]; onChange: (v: unknown) => void }) {
  const { roles, guildName, rolesError } = useRoles(true);

  if (!roles) {
    if (rolesError) {
      return (
        <div className="max-w-md space-y-1.5">
          <Input
            value={value.join(", ")}
            onChange={(e) =>
              onChange(
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            placeholder="IDs separados por comas"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">{rolesError} — pega los IDs a mano.</p>
        </div>
      );
    }
    return <p className="text-sm text-muted-foreground">Cargando roles…</p>;
  }

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div className="max-w-md space-y-1.5">
      <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-border bg-[#1a1a1a] p-2">
        {roles.map((r) => (
          <label
            key={r.id}
            className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-white/[0.04]"
          >
            <input
              type="checkbox"
              checked={value.includes(r.id)}
              onChange={() => toggle(r.id)}
              className="size-4 accent-[#8b93ff]"
            />
            <RoleDot color={r.color} />
            <span className="truncate font-semibold">@{r.name}</span>
          </label>
        ))}
      </div>
      <p className="font-mono text-[11px] text-zinc-500">
        {value.length === 0 ? `ninguno · ${guildName}` : `${value.length} rol(es) · ${guildName}`}
      </p>
    </div>
  );
}
