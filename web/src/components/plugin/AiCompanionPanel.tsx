import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  Eye,
  Loader2,
  Send,
  Sparkles,
  Square,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { supportLevel, supportHint } from "@/lib/ai-companion/support";
import { AI_COMPANION_MODELS, estimateDevice, modelLabel, recommendModel } from "@/lib/ai-companion/models";
import { buildChatComLink, buildExternalPrompt, extractThinking, visibleStreamingText } from "@/lib/ai-companion/prompts";
import {
  changedFiles,
  createDraftStore,
  discardAll,
  markApplied,
  syncDraftWithEditor,
  type DraftFile,
  type DraftState,
} from "@/lib/ai-companion/tools";
import type { HistoryMsg, StepEvent } from "@/lib/ai-companion/agent";
import type { Artifact } from "@/lib/ai-companion/prompts";
import { DiffView } from "./DiffView";

interface Props {
  pluginName: string;
  code: string;
  lastError: string;
  schemaRaw: string;
  toml: string;
  model: string;
  onModelChange: (id: string) => void;
  onApplyFile: (path: DraftFile, content: string) => void;
}

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  artifact?: Artifact;
  steps?: StepEvent[];
  streaming?: boolean;
  applied?: boolean;
}

function renderRich(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /```(\w*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const pushProse = (s: string, k: string) => {
    const t = s.trim();
    if (!t) return;
    out.push(
      <div key={k} className="max-w-full min-w-0 whitespace-pre-wrap break-words">
        {t}
      </div>,
    );
  };
  while ((m = re.exec(text)) !== null) {
    pushProse(text.slice(last, m.index), `${keyPrefix}-t${i}`);
    const code = m[2].trim().slice(0, 3000);
    // Las cercas vacías (degeneración típica de modelos pequeños) no se pintan.
    if (code) {
      out.push(
        <pre
          key={`${keyPrefix}-c${i}`}
          className="overflow-x-auto rounded-lg border border-border bg-[#101010] p-2.5 font-mono text-[11px] leading-relaxed text-zinc-200"
        >
          {code}
        </pre>,
      );
    }
    last = m.index + m[0].length;
    i++;
  }
  pushProse(text.slice(last), `${keyPrefix}-t${i}`);
  if (out.length === 0) {
    out.push(
      <div key={`${keyPrefix}-empty`} className="text-muted-foreground">
        …
      </div>,
    );
  }
  return out;
}

function StepRow({ step, active }: { step: StepEvent; active: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      {step.kind === "thinking" &&
        (active ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : (
          <Bot className="size-3 shrink-0" />
        ))}
      {step.kind === "tool-call" && <Wrench className="size-3 shrink-0 text-[#a78bfa]" />}
      {step.kind === "tool-result" &&
        (step.ok ? (
          <Check className="size-3 shrink-0 text-[#00d4aa]" />
        ) : (
          <X className="size-3 shrink-0 text-[#ff7a78]" />
        ))}
      {step.kind === "done" && <Check className="size-3 shrink-0 text-[#00d4aa]" />}
      {step.kind === "error" && <TriangleAlert className="size-3 shrink-0 text-[#ff7a78]" />}
      <span className="min-w-0 flex-1 truncate">{step.text}</span>
    </div>
  );
}

export function AiCompanionPanel({
  pluginName,
  code,
  lastError,
  schemaRaw,
  toml,
  model,
  onModelChange,
  onApplyFile,
}: Props) {
  const [tab, setTab] = useState<"chat" | "diff">("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [engineNote, setEngineNote] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);
  const [copied, setCopied] = useState(false);

  const storeRef = useRef<DraftState | null>(null);
  if (!storeRef.current) {
    storeRef.current = createDraftStore({ code, schemaRaw, toml });
  }
  const historyRef = useRef<HistoryMsg[]>([]);
  const cancelledRef = useRef(false);
  const idRef = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);

  const level = useMemo(() => supportLevel(), []);
  const hint = useMemo(() => supportHint(), []);
  const device = useMemo(() => estimateDevice(), []);
  const recommended = useMemo(() => recommendModel(device), [device]);
  const needsSwitch = !!recommended && recommended.id !== model;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, tab]);

  const changed = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => (storeRef.current ? changedFiles(storeRef.current) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftVersion, messages],
  );

  const patchMessage = useCallback((id: number, patch: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const appendStep = useCallback((id: number, step: StepEvent) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, steps: [...(m.steps ?? []), step] } : m)),
    );
  }, []);

  const send = useCallback(
    async (preset?: string) => {
      const store = storeRef.current;
      if (!store || running || level === "fallback") return;
      const text = (preset ?? input).trim();
      if (!text) return;
      syncDraftWithEditor(store, { code, schemaRaw, toml });
      const userMsg: ChatMessage = { id: idRef.current++, role: "user", text };
      const asstId = idRef.current++;
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: asstId, role: "assistant", text: "", steps: [], streaming: true },
      ]);
      setInput("");
      setRunning(true);
      cancelledRef.current = false;
      try {
        const { runAgentTurn } = await import("@/lib/ai-companion/agent");
        const res = await runAgentTurn(
          store,
          { code, lastError, pluginName, schemaRaw, toml },
          text,
          model,
          historyRef.current,
          {
            onProgress: (p, t) => setEngineNote(`${t} (${p}%)`),
            onToken: (partial) => {
              setEngineNote(null);
              patchMessage(asstId, { text: partial });
            },
            onStep: (s) => {
              setEngineNote(null);
              appendStep(asstId, s);
            },
            isCancelled: () => cancelledRef.current,
          },
        );
        setDraftVersion((v) => v + 1);
        if (res.cancelled) {
          appendStep(asstId, { kind: "done", text: "Detenido." });
          patchMessage(asstId, { text: res.text || "Detenido por ti — el borrador queda como estaba.", streaming: false });
        } else {
          const { rest } = extractThinking(res.text);
          patchMessage(asstId, {
            text: rest,
            artifact: res.artifact,
            streaming: false,
          });
          historyRef.current.push(
            { role: "user", content: text },
            { role: "assistant", content: rest },
          );
        }
      } catch (e) {
        appendStep(asstId, {
          kind: "error",
          text: String(e instanceof Error ? e.message : e).slice(0, 300),
        });
        patchMessage(asstId, { streaming: false });
      } finally {
        setRunning(false);
        setEngineNote(null);
      }
    },
    [running, level, input, code, lastError, pluginName, schemaRaw, toml, model, patchMessage, appendStep],
  );

  const applyAllChanged = useCallback(
    (msgId: number) => {
      const store = storeRef.current;
      if (!store) return;
      for (const f of changedFiles(store)) {
        onApplyFile(f, store.draft[f]);
      }
      // Lo aplicado deja de ser diff: el editor ya lo tiene.
      markApplied(store, changedFiles(store));
      setDraftVersion((v) => v + 1);
      patchMessage(msgId, { applied: true });
    },
    [onApplyFile, patchMessage],
  );

  const handleApplyFile = useCallback(
    (path: DraftFile, content: string) => {
      const store = storeRef.current;
      onApplyFile(path, content);
      if (store) {
        markApplied(store, [path]);
        setDraftVersion((v) => v + 1);
      }
    },
    [onApplyFile],
  );

  const copyText = useCallback(async (text: string, done?: () => void) => {
    try {
      await navigator.clipboard.writeText(text);
      done?.();
    } catch {
      window.prompt("Copia el texto:", text.slice(0, 2000));
    }
  }, []);

  const externalPrompt = useMemo(
    () =>
      buildExternalPrompt(
        { code, lastError, pluginName, schemaRaw },
        `${window.location.origin}/api/docs/plugin-api`,
        input || undefined,
      ),
    [code, lastError, pluginName, schemaRaw, input],
  );

  const chatLink = useMemo(
    () =>
      buildChatComLink(
        { code, lastError, pluginName, schemaRaw },
        `${window.location.origin}/api/docs/plugin-api`,
        input || undefined,
      ),
    [code, lastError, pluginName, schemaRaw, input],
  );

  const copyPrompt = async () => {
    await copyText(externalPrompt, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Card className="min-w-0 overflow-hidden border-[#a78bfa33]">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <Sparkles className="size-4 text-[#a78bfa]" />
          AI-Companion
          <Badge variant="warning" className="ml-1">
            experimental
          </Badge>
        </CardTitle>
        <CardDescription>
          {needsSwitch && recommended
            ? `Para tu equipo va mejor ${modelLabel(recommended.id)}.`
            : "Todo en local, nada sale de tu PC."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {hint && (
          <p className="flex items-start gap-2 rounded-xl border border-[#ffb70033] bg-[#ffb70011] px-3 py-2 text-[12px] leading-relaxed text-[#ffb700]">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {hint}
          </p>
        )}

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-bold text-muted-foreground">
            Modelo (solo este navegador)
          </span>
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            className="h-9 w-full rounded-xl border border-input bg-[#1a1a1a] px-2.5 text-[13px] font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [color-scheme:dark]"
          >
            {AI_COMPANION_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {recommended && recommended.id === m.id ? " · recomendado" : ""}
              </option>
            ))}
          </select>
        </label>

        {/* Tabs Chat / Cambios */}
        <div className="flex gap-1.5 rounded-xl border border-border bg-[#141414] p-1">
          {(["chat", "diff"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold transition-colors",
                tab === t ? "bg-[#a78bfa22] text-white" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "chat" ? <Bot className="size-3.5" /> : <Eye className="size-3.5" />}
              {t === "chat" ? "Chat" : `Cambios${changed.length > 0 ? ` (${changed.length})` : ""}`}
            </button>
          ))}
        </div>

        {tab === "diff" ? (
          <DiffView
            baseline={storeRef.current?.baseline ?? { "plugin.js": "", "schema.yml": "", "config.toml": "" }}
            draft={storeRef.current?.draft ?? { "plugin.js": "", "schema.yml": "", "config.toml": "" }}
            changed={changed}
            onApplyFile={handleApplyFile}
            onDiscardAll={() => {
              if (storeRef.current) discardAll(storeRef.current);
              setDraftVersion((v) => v + 1);
            }}
          />
        ) : (
          <>
            {engineNote && (
              <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                <span className="min-w-0 flex-1 truncate">{engineNote}</span>
              </p>
            )}

            <div ref={listRef} className="max-h-[46vh] min-w-0 space-y-2.5 overflow-x-hidden overflow-y-auto pr-0.5">
              {messages.length === 0 && (
                <p className="rounded-xl border border-border bg-[#141414] p-3 text-[12px] leading-relaxed text-muted-foreground">
                  Cuéntame qué quieres hacer con este plugin. Puedo leerlo, editarlo en borrador y
                  enseñarte el diff antes de que apliques nada.
                </p>
              )}
              {messages.map((m) =>
                m.role === "user" ? (
                  <div
                    key={m.id}
                    className="ml-8 min-w-0 rounded-xl rounded-br-sm bg-[#a78bfa22] px-3 py-2 text-[13px] leading-relaxed break-words"
                  >
                    {m.text}
                  </div>
                ) : (
                  <div key={m.id} className="mr-2 min-w-0 space-y-1.5 rounded-xl rounded-bl-sm border border-border bg-[#141414] px-3 py-2">
                    {(m.steps ?? []).map((s, i) => (
                      <StepRow key={i} step={s} active={!!m.streaming} />
                    ))}
                    {(m.streaming ? visibleStreamingText(m.text) !== "" : m.text !== "") && (
                      <div className="min-w-0 space-y-2 text-[13px] leading-relaxed">
                        {renderRich(m.streaming ? visibleStreamingText(m.text) : m.text, `m${m.id}`)}
                      </div>
                    )}
                    {!m.streaming && m.artifact?.kind === "code" && m.artifact.code && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        <Button size="sm" variant="secondary" onClick={() => setTab("diff")}>
                          <Eye className="size-4" />
                          Ver cambios
                        </Button>
                        {m.applied ? (
                          <Button size="sm" variant="ghost" disabled>
                            <Check className="size-4" />
                            Aplicado ✓
                          </Button>
                        ) : (
                          <Button size="sm" onClick={() => applyAllChanged(m.id)}>
                            <Check className="size-4" />
                            Aplicar al editor
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => copyText(m.artifact?.code ?? "")}>
                          <Copy className="size-4" />
                          Copiar
                        </Button>
                      </div>
                    )}
                    {!m.streaming && m.artifact?.kind === "explanation" && m.text && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        <Button size="sm" variant="ghost" onClick={() => copyText(m.text)}>
                          <Copy className="size-4" />
                          Copiar
                        </Button>
                      </div>
                    )}
                  </div>
                ),
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {lastError && (
                <Button size="sm" variant="outline" disabled={running || level === "fallback"} onClick={() => send(`Arréglame este error:\n${lastError}`)}>
                  <Wrench className="size-4" />
                  Arreglar error
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={running || level === "fallback"}
                onClick={() => send("Explícame qué hace este plugin en 5 líneas.")}
              >
                <Bot className="size-4" />
                Explicar
              </Button>
            </div>

            <div className="flex gap-1.5">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={2}
                placeholder="Pide un cambio… (Enter envía)"
                disabled={running || level === "fallback"}
                className="w-full rounded-xl border border-input bg-[#1a1a1a] px-3 py-2 text-[13px] text-foreground placeholder:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
              />
              {running ? (
                <Button
                  size="icon"
                  variant="secondary"
                  title="Detener"
                  onClick={() => {
                    cancelledRef.current = true;
                  }}
                >
                  <Square className="size-4" />
                </Button>
              ) : (
                <Button size="icon" disabled={!input.trim() || level === "fallback"} onClick={() => send()}>
                  <Send className="size-4" />
                </Button>
              )}
            </div>
          </>
        )}

        {/* Fallback: sin modelo local o si el local no convence */}
        <div className="rounded-xl border border-border bg-[#141414] p-3">
          <p className="mb-2 text-[12px] font-bold text-muted-foreground">
            {level === "fallback" ? "Este equipo no da para el modo local:" : "¿Prefieres hacerlo fuera?"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={copyPrompt}>
              <Copy className="size-4" />
              {copied ? "Copiado ✓" : "Copiar prompt"}
            </Button>
            <a href={chatLink.url} target="_blank" rel="noreferrer">
              <Button size="sm" variant="outline">
                <ExternalLink className="size-4" />
                Abrir en ChatGPT
              </Button>
            </a>
          </div>
          {chatLink.truncated && (
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
              El enlace lleva versión corta; copiar lleva la completa.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
