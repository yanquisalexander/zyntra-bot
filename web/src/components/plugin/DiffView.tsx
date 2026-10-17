import { useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DraftFile } from "@/lib/ai-companion/tools";

const LANG: Record<DraftFile, string> = {
  "plugin.js": "javascript",
  "schema.yml": "yaml",
  "config.toml": "ini",
};

interface Props {
  baseline: Record<DraftFile, string>;
  draft: Record<DraftFile, string>;
  changed: DraftFile[];
  onApplyFile: (path: DraftFile, content: string) => void;
  onDiscardAll: () => void;
}

/**
 * El "temp git": original = foto al abrir la sesión, modified = borrador
 * del agente. Nada aquí toca disco; aplicar escribe en el editor y guardar
 * sigue siendo manual con los botones de siempre.
 */
export function DiffView({ baseline, draft, changed, onApplyFile, onDiscardAll }: Props) {
  const [file, setFile] = useState<DraftFile>(changed[0] ?? "plugin.js");
  const current: DraftFile = changed.includes(file) ? file : (changed[0] ?? "plugin.js");

  if (changed.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-[#141414] p-4 text-center">
        <p className="text-[13px] font-bold">Sin cambios</p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          El borrador está igual que el original. Pídele algo al chat y aparecerá aquí el diff.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {changed.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFile(f)}
            className={cn(
              "rounded-lg border px-2.5 py-1 font-mono text-[11px] font-bold transition-colors",
              f === current
                ? "border-[#a78bfa66] bg-[#a78bfa22] text-white"
                : "border-border bg-[#141414] text-muted-foreground hover:text-foreground",
            )}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <DiffEditor
          height="46vh"
          language={LANG[current]}
          theme="vs-dark"
          original={baseline[current]}
          modified={draft[current]}
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: "'JetBrains Mono', monospace",
            scrollBeyondLastLine: false,
            renderSideBySide: false,
            readOnly: true,
          }}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onApplyFile(current, draft[current])}>
          <Check className="size-4" />
          Aplicar {current}
        </Button>
        {changed.length > 1 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => changed.forEach((f) => onApplyFile(f, draft[f]))}
          >
            <Check className="size-4" />
            Aplicar todo
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDiscardAll}>
          <RotateCcw className="size-4" />
          Descartar
        </Button>
      </div>
    </div>
  );
}
