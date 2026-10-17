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
import { ThinkingTimeline } from "./ThinkingTimeline";
import { ModelLoadBar } from "./ModelLoadBar";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// renderRich — inline markdown renderer
// ---------------------------------------------------------------------------

/**
 * Splits an inline markdown string into React nodes, handling:
 *  **bold**, *italic*, _italic_, `inline code`
 */
function renderInline(text: string, key: string): ReactNode {
  // Pattern order matters: bold before italic so **x** isn't misread as *x*
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|`([^`]+)`)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(text.slice(last, m.index));
    }
    if (m[2] !== undefined) {
      // **bold**
      nodes.push(<strong key={`${key}-b${i}`}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      // *italic*
      nodes.push(<em key={`${key}-e${i}`}>{m[3]}</em>);
    } else if (m[4] !== undefined) {
      // _italic_
      nodes.push(<em key={`${key}-u${i}`}>{m[4]}</em>);
    } else if (m[5] !== undefined) {
      // `inline code`
      nodes.push(
        <code
          key={`${key}-ic${i}`}
          className="bg-[#1e1e1e] rounded px-1 py-0.5 font-mono text-[11px] text-[#a78bfa]"
        >
          {m[5]}
        </code>,
      );
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes.length === 1 ? nodes[0] : <>{nodes}</>;
}

/**
 * Returns true if a block of prose text looks like bare (unfenced) code —
 * more than 500 chars where most lines start with spaces (indented code dump).
 */
function looksLikeUnfencedCode(text: string): boolean {
  if (text.length <= 500) return false;
  const lines = text.split("\n");
  const indented = lines.filter((l) => /^ {2,}/.test(l)).length;
  return indented > lines.length * 0.4;
}

/**
 * Renders a block of prose lines: headers, lists, and paragraphs.
 * Each line goes through `renderInline` for bold/italic/code.
 */
function renderProseBlock(raw: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = raw.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Headers ──────────────────────────────────────────────────────────────
    const h1 = /^# (.+)$/.exec(line);
    if (h1) {
      nodes.push(
        <h3 key={`${keyPrefix}-h1-${i}`} className="font-bold text-[14px] mt-2 mb-1">
          {renderInline(h1[1], `${keyPrefix}-h1i-${i}`)}
        </h3>,
      );
      i++;
      continue;
    }
    const h2 = /^## (.+)$/.exec(line);
    if (h2) {
      nodes.push(
        <h4 key={`${keyPrefix}-h2-${i}`} className="font-bold text-[13px] mt-1.5 mb-0.5 text-zinc-300">
          {renderInline(h2[1], `${keyPrefix}-h2i-${i}`)}
        </h4>,
      );
      i++;
      continue;
    }
    const h3 = /^### (.+)$/.exec(line);
    if (h3) {
      nodes.push(
        <h4 key={`${keyPrefix}-h3-${i}`} className="font-bold text-[12px] mt-1 mb-0.5 text-zinc-400">
          {renderInline(h3[1], `${keyPrefix}-h3i-${i}`)}
        </h4>,
      );
      i++;
      continue;
    }

    // ── Unordered list ────────────────────────────────────────────────────────
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(lines[i].replace(/^[-*] /, ""));
        i++;
      }
      nodes.push(
        <ul key={`${keyPrefix}-ul-${i}`}>
          {items.map((item, j) => (
            <li key={j} className="ml-4 text-[13px] leading-relaxed list-disc">
              {renderInline(item, `${keyPrefix}-ul-${i}-li${j}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // ── Ordered list ──────────────────────────────────────────────────────────
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ""));
        i++;
      }
      nodes.push(
        <ol key={`${keyPrefix}-ol-${i}`}>
          {items.map((item, j) => (
            <li key={j} className="ml-4 text-[13px] leading-relaxed list-decimal">
              {renderInline(item, `${keyPrefix}-ol-${i}-li${j}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // ── Regular paragraph line ────────────────────────────────────────────────
    const trimmed = line.trim();
    if (trimmed) {
      nodes.push(
        <span key={`${keyPrefix}-p-${i}`} className="block">
          {renderInline(trimmed, `${keyPrefix}-pi-${i}`)}
        </span>,
      );
    }
    i++;
  }

  return nodes;
}

function renderRich(text: string, keyPrefix: string, isStreaming?: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  const pushProse = (s: string, k: string) => {
    const t = s.trim();
    if (!t) return;

    // ── Req 6: suppress unfenced code dumps during streaming ─────────────────
    if (isStreaming && looksLikeUnfencedCode(t)) {
      out.push(
        <span key={`${k}-unfenced`} className="text-zinc-500 italic text-[11px]">
          ⏳ Procesando respuesta...
        </span>,
      );
      return;
    }

    const proseNodes = renderProseBlock(t, k);
    if (proseNodes.length > 0) {
      out.push(
        <div key={k} className="max-w-full min-w-0 space-y-0.5">
          {proseNodes}
        </div>,
      );
    }
  };

  while ((m = re.exec(text)) !== null) {
    pushProse(text.slice(last, m.index), `${keyPrefix}-t${i}`);

    const lang = m[1].trim();
    let code = m[2].trim().slice(0, 3000);

    // ── Req 4: limit plugin code blocks during streaming ──────────────────────
    if (
      isStreaming &&
      code.length > 600 &&
      (code.includes("definePlugin") || code.includes("setup(api)"))
    ) {
      const lines = code.split("\n");
      code = lines.slice(0, 8).join("\n");
      out.push(
        <div key={`${keyPrefix}-c${i}`} className="rounded-lg border border-border overflow-hidden">
          {/* ── Req 5: language title bar ───────────────────────────────── */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#0a0a0a] border-b border-border rounded-t-lg text-[10px] text-zinc-500">
            {lang || "code"}
          </div>
          <pre className="overflow-x-auto rounded-t-none bg-[#101010] p-2.5 font-mono text-[11px] leading-relaxed text-zinc-200">
            {code}
          </pre>
          <div className="px-2.5 py-1 bg-[#101010] border-t border-border text-[11px] text-zinc-500 italic">
            …(procesando, se mostrará al terminar)
          </div>
        </div>,
      );
    } else if (code) {
      // ── Full code block with title bar ────────────────────────────────────
      out.push(
        <div key={`${keyPrefix}-c${i}`} className="rounded-lg border border-border overflow-hidden">
          {/* ── Req 5: language title bar ───────────────────────────────── */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#0a0a0a] border-b border-border rounded-t-lg text-[10px] text-zinc-500">
            {lang || "code"}
          </div>
          <pre className="overflow-x-auto rounded-t-none bg-[#101010] p-2.5 font-mono text-[11px] leading-relaxed text-zinc-200">
            {code}
          </pre>
        </div>,
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

/**
 * Returns true if a streaming text looks like raw plugin code being echoed back
 * (definePlugin / setup(api) presence + length > 400).
 * Used to suppress rendering and show a "Procesando…" placeholder instead.
 */
function looksLikePluginCode(text: string): boolean {
  if (text.length <= 400) return false;
  const hasMarker =
    text.trimStart().startsWith("definePlugin") || text.includes("setup(api)");
  return hasMarker;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  const [draftVersion, setDraftVersion] = useState(0);
  const [copied, setCopied] = useState(false);

  // ── Model load state ──────────────────────────────────────────────────────
  const [loadPhase, setLoadPhase] = useState<"idle" | "loading" | "ready" | "generating" | "error">("idle");
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadText, setLoadText] = useState("");

  const storeRef = useRef<DraftState | null>(null);
  if (!storeRef.current) {
    storeRef.current = createDraftStore({ code, schemaRaw, toml });
  }
  const historyRef = useRef<HistoryMsg[]>([]);
  const cancelledRef = useRef(false);
  const idRef = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);
  // Track whether we've received the first token (to know when loading ends)
  const firstTokenRef = useRef(false);

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
      firstTokenRef.current = false;

      try {
        const { runAgentTurn } = await import("@/lib/ai-companion/agent");
        const res = await runAgentTurn(
          store,
          { code, lastError, pluginName, schemaRaw, toml },
          text,
          model,
          historyRef.current,
          {
            onProgress: (p, t) => {
              setLoadPhase("loading");
              setLoadProgress(p);
              setLoadText(t ?? "");
              // If we somehow reach 100% via progress, flip to ready
              if (p >= 100 && !firstTokenRef.current) {
                setLoadPhase("ready");
                // Transition to generating after the badge auto-hides (3 s)
                setTimeout(() => setLoadPhase("generating"), 100);
              }
            },
            onToken: (partial) => {
              // First token signals the model finished loading
              if (!firstTokenRef.current) {
                firstTokenRef.current = true;
                setLoadPhase("ready");
                // Give the "ready" badge a moment to show, then switch to generating
                setTimeout(() => setLoadPhase("generating"), 100);
              }
              patchMessage(asstId, { text: partial });
            },
            onStep: (s) => {
              appendStep(asstId, s);
            },
            isCancelled: () => cancelledRef.current,
          },
        );
        setDraftVersion((v) => v + 1);
        if (res.cancelled) {
          appendStep(asstId, { kind: "done", text: "Detenido." });
          patchMessage(asstId, {
            text: res.text || "Detenido por ti — el borrador queda como estaba.",
            streaming: false,
          });
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
        setLoadPhase("error");
      } finally {
        setRunning(false);
        // Only reset to idle if there's a final text (i.e., not stuck on error)
        setMessages((prev) => {
          const asst = prev.find((m) => m.id === asstId);
          if (asst && asst.text) {
            setLoadPhase("idle");
          }
          return prev;
        });
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

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  /** Renders an assistant message body depending on streaming state. */
  function renderAssistantBody(m: ChatMessage) {
    const steps = m.steps ?? [];
    const isStreaming = !!m.streaming;

    if (isStreaming) {
      // ── While streaming: ThinkingTimeline + subtle "thinking" spinner ──────
      const streamText = visibleStreamingText(m.text);
      const showProcessing = looksLikePluginCode(streamText);

      return (
        <>
          <ThinkingTimeline steps={steps} active={true} defaultExpanded={true} />
          {streamText !== "" && (
            <div className="min-w-0 space-y-2 text-[13px] leading-relaxed">
              {showProcessing ? (
                <span className="text-zinc-500 text-[11px]">Procesando...</span>
              ) : (
                renderRich(streamText, `m${m.id}`, true)
              )}
            </div>
          )}
          {streamText === "" && steps.length === 0 && (
            <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Loader2 className="size-3 animate-spin" />
              El modelo está pensando…
            </span>
          )}
        </>
      );
    }

    // ── Final response: collapsible ThinkingTimeline + final text block ──────
    return (
      <>
        <ThinkingTimeline steps={steps} active={false} />
        {m.text !== "" && (
          <div className="min-w-0 space-y-2 border-l-2 border-[#a78bfa44] pl-3 text-[13px] leading-relaxed">
            {renderRich(m.text, `m${m.id}`, false)}
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
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // JSX
  // ---------------------------------------------------------------------------

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
                  <div
                    key={m.id}
                    className="mr-2 min-w-0 space-y-1.5 rounded-xl rounded-bl-sm border border-border bg-[#141414] px-3 py-2"
                  >
                    {renderAssistantBody(m)}
                  </div>
                ),
              )}
            </div>

            {/* Model load progress bar — shown above the input area */}
            <ModelLoadBar
              phase={loadPhase}
              progress={loadProgress}
              text={loadText}
            />

            <div className="flex flex-wrap gap-1.5">
              {lastError && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running || level === "fallback"}
                  onClick={() => send(`Arréglame este error:\n${lastError}`)}
                >
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
