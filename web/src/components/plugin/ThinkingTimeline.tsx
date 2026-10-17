import { useEffect, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { StepEvent } from "@/lib/ai-companion/agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  steps: StepEvent[];
  active: boolean;
  defaultExpanded?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract tool name from a tool-call step text like "leyendo plugin.js" */
function extractToolName(text: string): string {
  // tool-call texts are produced by toolLabel(): "<verb> <path>"
  // We try to grab the first meaningful word that looks like a tool op.
  const verbs: Record<string, string> = {
    leyendo: "read-file",
    editando: "edit-file",
    validando: "check-syntax",
    preparando: "show-diff",
  };
  const first = text.split(" ")[0]?.toLowerCase() ?? "";
  return verbs[first] ?? text.split(" ").slice(0, 2).join(" ") ?? text;
}

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/** Build a short summary string from the step list, e.g. "Leyó 2 archivos · editó 1 · validó OK" */
function buildSummary(steps: StepEvent[]): string {
  let reads = 0;
  let edits = 0;
  let validated = false;
  let errors = 0;

  for (const s of steps) {
    if (s.kind === "tool-call") {
      const t = s.text.toLowerCase();
      if (t.startsWith("leyendo")) reads++;
      else if (t.startsWith("editando")) edits++;
      else if (t.startsWith("validando")) validated = true;
    }
    if (s.kind === "tool-result" && !s.ok) errors++;
    if (s.kind === "error") errors++;
  }

  const parts: string[] = [];
  if (reads > 0) parts.push(`Leyó ${reads} ${reads === 1 ? "archivo" : "archivos"}`);
  if (edits > 0) parts.push(`editó ${edits}`);
  if (validated) parts.push("validó OK");
  if (errors > 0) parts.push(`${errors} error${errors > 1 ? "es" : ""}`);

  return parts.length > 0 ? parts.join(" · ") : `${steps.length} pasos`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ active, hasError }: { active: boolean; hasError: boolean }) {
  if (active) {
    return (
      <span className="relative flex size-4 items-center justify-center">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-violet-400 opacity-60" />
        <Loader2 className="relative size-3.5 animate-spin text-violet-400" />
      </span>
    );
  }
  if (hasError) {
    return <X className="size-3.5 text-[#ff7a78]" />;
  }
  return <Check className="size-3.5 text-[#00d4aa]" />;
}

function StepRowItem({
  step,
  isLastActive,
}: {
  step: StepEvent;
  isLastActive: boolean;
}) {
  const pulse = isLastActive
    ? "relative after:absolute after:inset-0 after:rounded-lg after:animate-ping after:bg-violet-500/10 after:pointer-events-none"
    : "";

  // ── thinking ──────────────────────────────────────────────────────────────
  if (step.kind === "thinking") {
    return (
      <div className={cn("flex min-w-0 items-start gap-2 rounded-lg px-2 py-1", pulse)}>
        {isLastActive ? (
          <Loader2 className="mt-px size-3.5 shrink-0 animate-spin text-zinc-400" />
        ) : (
          <Bot className="mt-px size-3.5 shrink-0 text-zinc-500" />
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500">{step.text}</span>
      </div>
    );
  }

  // ── tool-call ─────────────────────────────────────────────────────────────
  if (step.kind === "tool-call") {
    const toolName = extractToolName(step.text);
    return (
      <div className={cn("flex min-w-0 items-start gap-2 rounded-lg px-2 py-1", pulse)}>
        <Wrench className="mt-px size-3.5 shrink-0 text-[#a78bfa]" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-300">{step.text}</span>
        <Badge
          variant="secondary"
          className="ml-auto shrink-0 bg-[#a78bfa22] px-1.5 py-0 text-[10px] font-mono text-[#a78bfa]"
        >
          {toolName}
        </Badge>
      </div>
    );
  }

  // ── tool-result ───────────────────────────────────────────────────────────
  if (step.kind === "tool-result") {
    if (step.ok) {
      return (
        <div className={cn("flex min-w-0 items-start gap-2 rounded-lg px-2 py-1", pulse)}>
          <Check className="mt-px size-3.5 shrink-0 text-[#00d4aa]" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-400">
            {truncate(step.text)}
          </span>
        </div>
      );
    }
    return (
      <div
        className={cn(
          "flex min-w-0 items-start gap-2 rounded-lg border border-[#ff7a7822] bg-[#ff7a7808] px-2 py-1",
          pulse,
        )}
      >
        <X className="mt-px size-3.5 shrink-0 text-[#ff7a78]" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-[#ff7a78]">
          {truncate(step.text)}
        </span>
      </div>
    );
  }

  // ── done ──────────────────────────────────────────────────────────────────
  if (step.kind === "done") {
    return (
      <div className="flex min-w-0 items-start gap-2 rounded-lg px-2 py-1">
        <Check className="mt-px size-3.5 shrink-0 text-[#00d4aa]" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-zinc-200">
          {step.text}
        </span>
      </div>
    );
  }

  // ── error ─────────────────────────────────────────────────────────────────
  if (step.kind === "error") {
    return (
      <div className="flex min-w-0 items-start gap-2 rounded-lg px-2 py-1">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-[#ff7a78]" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-[#ff7a78]">{step.text}</span>
      </div>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ThinkingTimeline({ steps, active, defaultExpanded }: Props) {
  const [expanded, setExpanded] = useState(active || defaultExpanded || false);

  // Auto-expand while active; auto-collapse after finishing (if no errors).
  useEffect(() => {
    if (!active) {
      const hasError = steps.some(
        (s) => s.kind === "error" || (s.kind === "tool-result" && !s.ok),
      );
      if (!hasError) {
        const t = setTimeout(() => setExpanded(false), 1200);
        return () => clearTimeout(t);
      }
    } else {
      setExpanded(true);
    }
  }, [active, steps]);

  // Nothing to show
  if (steps.length === 0) return null;

  const hasError = steps.some(
    (s) => s.kind === "error" || (s.kind === "tool-result" && !s.ok),
  );
  const lastIdx = steps.length - 1;
  const summary = buildSummary(steps);

  return (
    <div className="min-w-0 rounded-xl border border-[#ffffff0d] bg-[#0f0f0f]">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[#ffffff06]"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-zinc-500" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-zinc-500" />
        )}
        <span className="flex-1 text-[11px] font-semibold text-zinc-400">
          {steps.length} {steps.length === 1 ? "paso" : "pasos"}
        </span>
        {!expanded && !active && (
          <span className="truncate text-[10px] text-zinc-600">{summary}</span>
        )}
        <StatusBadge active={active} hasError={hasError} />
      </button>

      {/* ── Expanded list ──────────────────────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-[#ffffff0d] px-1 py-1.5 space-y-0.5">
          {steps.map((step, i) => (
            <StepRowItem
              key={i}
              step={step}
              isLastActive={i === lastIdx && active}
            />
          ))}
        </div>
      )}
    </div>
  );
}
