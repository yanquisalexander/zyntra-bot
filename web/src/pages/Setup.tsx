import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleX,
  Copy,
  Check,
  ExternalLink,
  KeyRound,
  PlugZap,
  Power,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { api, bootstrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, AlertError } from "@/components/common";
import { cn } from "@/lib/utils";

type Status = "ok" | "warn" | "fail";

interface SetupCheck {
  id: string;
  label: string;
  status: Status;
  detail: string;
  fix?: string;
}

const STATUS_META: Record<Status, { icon: typeof CheckCircle2; badge: "success" | "warning" | "destructive"; ring: string }> = {
  ok: { icon: CheckCircle2, badge: "success", ring: "border-[#00d4aa33]" },
  warn: { icon: TriangleAlert, badge: "warning", ring: "border-[#ffb70033]" },
  fail: { icon: CircleX, badge: "destructive", ring: "border-[#ff5e5b44]" },
};

export default function Setup({ mode }: { mode: "gate" | "page" }) {
  const [checks, setChecks] = useState<SetupCheck[] | null>(null);
  const [blocked, setBlocked] = useState<boolean | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"check" | "connect" | "token" | "claim" | "restart" | null>(null);
  const [copied, setCopied] = useState(false);
  const [token, setToken] = useState("");
  const [tokenErr, setTokenErr] = useState("");
  const [restarting, setRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState("");
  const myId = bootstrap().user?.discordId ?? null;

  const refresh = useCallback(async (manual = false) => {
    if (manual) setBusy("check");
    try {
      const d = await api<{ checks: SetupCheck[]; blocked: boolean }>("/api/setup/checks");
      setChecks(d.checks);
      setBlocked(d.blocked);
      setErr("");
      if (mode === "gate" && !d.blocked) {
        window.location.href = "/";
        return;
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      if (manual) setBusy(null);
    }
  }, [mode]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => refresh(), 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const connect = async () => {
    setBusy("connect");
    setErr("");
    try {
      await api("/api/bot/connect", { method: "POST" });
      await refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  /** Guarda el token (verificado contra Discord) y conecta en caliente. */
  const saveToken = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const t = token.trim();
    if (t.length < 50) {
      setTokenErr("Ese token parece corto: pega el Bot Token completo.");
      return;
    }
    setBusy("token");
    setTokenErr("");
    setErr("");
    try {
      const d = await api<{ ok: boolean; tag?: string | null; connected?: boolean; warning?: string }>(
        "/api/setup/token",
        { method: "POST", body: JSON.stringify({ token: t }) },
      );
      setToken("");
      if (d.warning) setErr(`Guardado, pero sin conectar: ${d.warning}`);
      await refresh();
    } catch (e2) {
      setTokenErr(String(e2 instanceof Error ? e2.message : e2));
    } finally {
      setBusy(null);
    }
  };

  /** Reclama admin cuando aún no hay ninguno (modo bootstrap). */
  const claimAdmin = async () => {
    setBusy("claim");
    setErr("");
    try {
      await api("/api/setup/claim-admin", { method: "POST" });
      await refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  /** Reinicio controlado: espera a que /api/health vuelva (hasta ~45s). */
  const restart = async () => {
    if (!confirm("¿Reiniciar el servidor? Se corta un momento y vuelve solo.")) return;
    setBusy("restart");
    setRestarting(true);
    setRestartMsg("Reiniciando… espero a que vuelva.");
    setErr("");
    try {
      await api("/api/setup/restart", { method: "POST" }).catch(() => ({ ok: true }));
    } catch {
      /* el servidor puede morir antes de responder: normal */
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const h = await fetch("/api/health").then((r) => r.json() as Promise<{ ok?: boolean }>);
        if (h?.ok) {
          window.location.reload();
          return;
        }
      } catch {
        /* aún caído */
      }
    }
    setRestarting(false);
    setBusy(null);
    setRestartMsg("");
    setErr("No volvió en 45s: arráncalo a mano (pnpm dev / docker) y pulsa Comprobar de nuevo.");
  };

  const copyId = async () => {
    if (!myId) return;
    try {
      await navigator.clipboard.writeText(myId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  const tokenOk = checks?.find((c) => c.id === "token")?.status === "ok";
  const tokenFail = checks?.find((c) => c.id === "token")?.status === "fail";
  const adminsFail = checks?.find((c) => c.id === "admins")?.status === "fail";
  const botCheck = checks?.find((c) => c.id === "bot");
  const okCount = checks?.filter((c) => c.status === "ok").length ?? 0;

  const body = (
    <div className="space-y-5">
      {mode === "page" && (
        <PageHeader
          title="Setup"
          description="Requisitos del bot: lo crítico bloquea, lo demás avisa."
          actions={
            <Button variant="secondary" onClick={() => refresh(true)} disabled={busy !== null}>
              <RefreshCw className="size-4" />
              Comprobar de nuevo
            </Button>
          }
        />
      )}

      {mode === "gate" && (
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#a78bfa] text-[#1a1033]">
            <Bot className="size-5" strokeWidth={2.5} />
          </span>
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              Primer setup
            </h1>
            <p className="text-sm font-bold text-muted-foreground">
              Deja todo en verde y entramos. ☕
            </p>
          </div>
        </div>
      )}

      {err && <AlertError message={err} />}

      {blocked === false && (
        <p className="rounded-xl border border-[#00d4aa33] bg-[#00d4aa11] px-4 py-2.5 text-sm font-bold text-[#00d4aa]">
          Todo lo crítico en orden ✓ {mode === "gate" ? "Entrando…" : "Puedes volver al panel."}
        </p>
      )}

      {!checks ? (
        <div className="space-y-2.5">
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
        </div>
      ) : (
        <Card>
          <CardContent className="space-y-2.5 p-4 sm:p-5">
            <div className="flex items-center justify-between px-1 pb-1">
              <p className="text-sm font-extrabold">
                {okCount}/{checks.length} en verde
              </p>
              <Badge variant={blocked ? "destructive" : "success"}>
                {blocked ? "bloqueado" : "listo"}
              </Badge>
            </div>
            {checks.map((c) => {
              const meta = STATUS_META[c.status];
              const Icon = meta.icon;
              return (
                <div key={c.id} className={cn("rounded-xl border bg-[#1a1a1a] px-4 py-3", meta.ring)}>
                  <div className="flex items-center gap-2.5">
                    <Icon className={cn(
                      "size-5 shrink-0",
                      c.status === "ok" ? "text-[#00d4aa]" : c.status === "warn" ? "text-[#ffb700]" : "text-[#ff7a78]",
                    )} strokeWidth={2.5} />
                    <p className="flex-1 text-sm font-extrabold">{c.label}</p>
                    <Badge variant={meta.badge}>{c.status === "ok" ? "ok" : c.status === "warn" ? "aviso" : "falta"}</Badge>
                  </div>
                  <p className="mt-1 pl-[30px] text-[13px] text-muted-foreground">{c.detail}</p>
                  {c.fix && (
                    <p className="mt-1.5 rounded-lg bg-black/30 px-3 py-2 pl-[30px] text-[13px] leading-relaxed text-foreground">
                      <span className="font-extrabold">Cómo arreglarlo: </span>{c.fix}
                      {c.id === "admins" && c.status === "fail" && myId && (
                        <Button variant="ghost" size="xs" className="ml-2 font-mono" onClick={copyId} title="Copiar tu ID">
                          {copied ? <Check className="size-3.5 text-[#00d4aa]" /> : <Copy className="size-3.5" />}
                          {myId}
                        </Button>
                      )}
                    </p>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {tokenFail && (
        <Card>
          <CardContent className="space-y-3 p-4 sm:p-5">
            <div className="flex items-center gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-[#ffb70033] bg-[#ffb70011] text-[#ffb700]">
                <KeyRound className="size-4" strokeWidth={2.5} />
              </span>
              <div>
                <p className="text-sm font-extrabold">Pega el Bot Token aquí</p>
                <p className="text-[13px] text-muted-foreground">
                  Lo verifico con Discord, lo guardo en el .env y conecto sin reiniciar.
                </p>
              </div>
            </div>
            <form onSubmit={saveToken} className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Bot Token (solo Bot, no Client Secret)"
                className="font-mono"
                autoComplete="off"
              />
              <Button type="submit" disabled={busy !== null || token.trim().length < 50} className="shrink-0">
                <PlugZap className="size-4" />
                {busy === "token" ? "Verificando…" : "Guardar y conectar"}
              </Button>
            </form>
            {tokenErr && <AlertError message={tokenErr} />}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {mode === "gate" ? (
          <Button onClick={() => refresh(true)} disabled={busy !== null}>
            <RefreshCw className="size-4" />
            {busy === "check" ? "Comprobando…" : "Comprobar de nuevo"}
          </Button>
        ) : (
          blocked === false && (
            <Link to="/">
              <Button>
                Volver al panel
                <ArrowRight className="size-4" />
              </Button>
            </Link>
          )
        )}
        {adminsFail && (
          <Button variant="secondary" onClick={claimAdmin} disabled={busy !== null}>
            <Check className="size-4" />
            {busy === "claim" ? "Reclamando…" : "Reclamarme como admin"}
          </Button>
        )}
        {tokenOk && botCheck?.status !== "ok" && (
          <Button variant="secondary" onClick={connect} disabled={busy !== null}>
            <PlugZap className="size-4" />
            {busy === "connect" ? "Encendiendo…" : "Encender bot"}
          </Button>
        )}
        <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">
          <Button variant="outline">
            Portal de Discord
            <ExternalLink className="size-3.5" />
          </Button>
        </a>
        <Button variant="ghost" onClick={restart} disabled={busy !== null} title="Reinicia el proceso (lo levanta tu process manager)">
          <Power className="size-4" />
          {busy === "restart" ? "Reiniciando…" : "Reiniciar servidor"}
        </Button>
      </div>

      {restarting && restartMsg && (
        <p className="rounded-xl border border-[#a78bfa33] bg-[#a78bfa11] px-4 py-2.5 text-sm font-bold text-[#a78bfa]">
          {restartMsg}
        </p>
      )}

      {mode === "gate" && (
        <p className="text-xs font-bold text-zinc-600">
          Reviso cada 10 segundos: en cuanto esté todo en verde entro solo. El token y el admin se aplican sin reiniciar; para el resto del .env usa el botón de reinicio.
        </p>
      )}
    </div>
  );

  if (mode === "gate") {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 font-sans text-foreground">
        {body}
      </div>
    );
  }
  return body;
}
