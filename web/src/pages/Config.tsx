import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Save, ShieldAlert, Server, FlaskConical, Users, ListChecks, Code2 } from "lucide-react";
import { api, bootstrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { PageHeader, AlertError, AlertOk } from "@/components/common";
import { AI_COMPANION_MODELS, DEFAULT_AI_MODEL, estimateDevice, modelLabel, recommendModel } from "@/lib/ai-companion/models";

interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
}

export default function Config() {
  const [cfg, setCfg] = useState<Record<string, unknown>>({});
  const [prefix, setPrefix] = useState("!");
  const [guildId, setGuildId] = useState("");
  const [aiEnabled, setAiEnabled] = useState(false);
  const [devModeEnabled, setDevModeEnabled] = useState(false);
  const [aiModel, setAiModel] = useState<string>(DEFAULT_AI_MODEL);
  const [deviceProfile] = useState(estimateDevice);
  const recommended = recommendModel(deviceProfile);
  const [guilds, setGuilds] = useState<DiscordGuild[] | null>(null);
  const [guildsError, setGuildsError] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bypass, setBypass] = useState(() => bootstrap().flags?.bypassAdminServerCheck ?? false);

  useEffect(() => {
    api<{ config: Record<string, unknown>; bypassAdminServerCheck?: boolean }>("/api/config")
      .then((d) => {
        setCfg(d.config);
        if (typeof d.bypassAdminServerCheck === "boolean") setBypass(d.bypassAdminServerCheck);
        if (typeof d.config.prefix === "string") setPrefix(d.config.prefix);
        if (typeof d.config.guildId === "string") setGuildId(d.config.guildId);
        if (typeof d.config.aiCompanionEnabled === "boolean") setAiEnabled(d.config.aiCompanionEnabled);
        if (typeof d.config.devModeEnabled === "boolean") setDevModeEnabled(d.config.devModeEnabled);
        if (typeof d.config.aiCompanionModel === "string" && d.config.aiCompanionModel) {
          setAiModel(d.config.aiCompanionModel);
        }
      })
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
    api<{ guilds: DiscordGuild[] }>("/api/discord/guilds")
      .then((d) => setGuilds(d.guilds))
      .catch((e) => setGuildsError(String(e instanceof Error ? e.message : e)));
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg("");
    setErr("");
    try {
      const d = await api<{ config: Record<string, unknown> }>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ ...cfg, prefix, guildId, aiCompanionEnabled: aiEnabled, aiCompanionModel: aiModel, devModeEnabled }),
      });
      setCfg(d.config ?? { ...cfg, prefix, guildId, aiCompanionEnabled: aiEnabled, aiCompanionModel: aiModel, devModeEnabled });
      window.dispatchEvent(new CustomEvent("zyntra:config-updated", { detail: d.config }));
      setMsg("Guardado ✓ — ya se está usando");
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Configuración"
        description="Ajustes del bot. Se aplican al momento, sin apagar nada."
        actions={
          <Button size="sm" disabled={saving || loading} onClick={save}>
            <Save className="size-4" />
            {saving ? "Guardando…" : "Guardar cambios"}
          </Button>
        }
      />

      {err && <AlertError message={err} />}
      {msg && <AlertOk message={msg} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Code2 className="size-4 text-[#8b93ff]" />
            Desarrollo
            <Badge variant={devModeEnabled ? "violet" : "secondary"}>{devModeEnabled ? "activo" : "apagado"}</Badge>
          </CardTitle>
          <CardDescription>Habilita una página independiente con métricas de ejecución.</CardDescription>
        </CardHeader>
        <CardContent>
          <Switch
            checked={devModeEnabled}
            onChange={setDevModeEnabled}
            label="Activar DEV Mode y mostrar métricas"
          />
          <p className="mt-2 max-w-xl text-[11px] leading-relaxed text-muted-foreground">
            Incluye llamadas, errores, latencia y memoria/CPU del proceso. Guarda los cambios para aplicarlo.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>Símbolo de comandos y ajustes compartidos</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">Símbolo de comandos</span>
            <Input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.slice(0, 5))}
              className="max-w-32 font-mono text-center text-lg font-bold"
              maxLength={5}
              placeholder="!"
            />
            <span className="mt-1.5 block text-[11px] text-muted-foreground">
              Los comandos del bot empezarán con este símbolo (p. ej. <span className="font-mono">{prefix}ping</span>).
            </span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Servidor</CardTitle>
          <CardDescription>El servidor único donde trabaja el bot</CardDescription>
        </CardHeader>
        <CardContent>
          {bypass && (
            <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-[#ffb70033] bg-[#ffb70011] px-4 py-3 text-[13px] leading-relaxed text-[#ffb700]">
              <Users className="mt-0.5 size-4 shrink-0" />
              <p>
                <span className="font-extrabold">Modo compartido:</span> cualquiera del panel
                puede configurar el bot para un servidor donde no es admin.
              </p>
            </div>
          )}
          {guildsError ? (
            <p className="text-sm text-muted-foreground">{guildsError} — guarda el resto igual.</p>
          ) : guilds === null ? (
            <p className="text-sm text-muted-foreground">Cargando servidores…</p>
          ) : guilds.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              El bot no está en ningún servidor. Invitalo primero y recarga.
            </p>
          ) : (
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium">Servidor del bot</span>
              <div className="flex items-center gap-2.5">
                <Server className="size-4 shrink-0 text-muted-foreground" />
                <select
                  value={guildId}
                  onChange={(e) => setGuildId(e.target.value)}
                  className="h-10 w-full rounded-xl border border-input bg-[#1a1a1a] px-3 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [color-scheme:dark]"
                >
                  <option value="">Sin elegir</option>
                  {guilds.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.memberCount} miembros)
                    </option>
                  ))}
                </select>
              </div>
              <span className="mt-1.5 block text-[11px] text-muted-foreground">
                Los comandos y eventos de otros servidores se ignoran. Los ajustes con roles usan este servidor.
              </span>
            </label>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="size-4 text-[#a78bfa]" />
            Experimental
            <Badge variant="warning">AI-Companion</Badge>
          </CardTitle>
          <CardDescription>
            Ayuda con WebLLM 100% local al editar plugins. La primera vez descarga ~1-2 GB.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Switch
            checked={aiEnabled}
            onChange={setAiEnabled}
            label="Activar AI-Companion en el editor de plugins"
          />
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">Modelo local</span>
            <select
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
              disabled={!aiEnabled}
              className="h-10 w-full rounded-xl border border-input bg-[#1a1a1a] px-3 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [color-scheme:dark] disabled:opacity-50"
            >
              {AI_COMPANION_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {(() => {
                    const rec = recommendModel(deviceProfile);
                    return rec && rec.id === m.id ? " · recomendado" : "";
                  })()}
                </option>
              ))}
              {!AI_COMPANION_MODELS.some((m) => m.id === aiModel) && (
                <option value={aiModel}>Desconocido: {aiModel}</option>
              )}
            </select>
            <span className="mt-1.5 block text-[11px] text-muted-foreground">
              {recommended ? (
                <>
                  Recomendado para tu equipo: {modelLabel(recommended.id)} ({recommended.reason}).{" "}
                  <button
                    type="button"
                    disabled={!aiEnabled || aiModel === recommended.id}
                    onClick={() => setAiModel(recommended.id)}
                    className="font-bold text-[#a78bfa] underline-offset-2 hover:underline disabled:opacity-40 disabled:no-underline"
                  >
                    Usar recomendado
                  </button>
                </>
              ) : (
                "Este equipo no da para el modo local: podrás usar el fallback de ChatGPT."
              )}
              <br />
              Todo queda en tu PC salvo que pulses «Abrir en ChatGPT».
            </span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resumen actual</CardTitle>
          <CardDescription>Así está guardado ahora mismo</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[50vh] overflow-auto rounded-xl border border-border bg-[#101010] p-4 font-mono text-xs leading-relaxed text-zinc-300">
            {loading ? "Cargando…" : JSON.stringify({ ...cfg, prefix, guildId, aiCompanionEnabled: aiEnabled, aiCompanionModel: aiModel, devModeEnabled }, null, 2)}
          </pre>
        </CardContent>
      </Card>

      <div className="flex items-start gap-2.5 rounded-xl border border-[#ffb70033] bg-[#ffb70011] px-4 py-3 text-[13px] leading-relaxed font-bold text-[#ffb700]">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <p className="flex-1">
          Las claves (como el token de Discord) solo están en el servidor, en el archivo{" "}
          <span className="font-mono">.env</span>, y nunca se muestran aquí.
        </p>
        <Link
          to="/setup"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[#ffb70044] px-2.5 py-1.5 text-xs font-extrabold transition-colors hover:bg-[#ffb70022]"
        >
          <ListChecks className="size-3.5" />
          Revisar requisitos
        </Link>
      </div>
    </div>
  );
}
