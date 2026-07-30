import { AnimatePresence, motion } from "framer-motion";
import { Minus, Plus } from "lucide-react";
import { Combobox } from "@/components/common/Combobox";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProviderModelOption } from "./inference-model-form";

const RESIZE_TRANSITION = { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const };

export function ModelReasoningFields({
  selected,
  mapping,
  setMapping,
  defaultEffort,
  setDefaultEffort,
}: {
  selected: ProviderModelOption | null;
  mapping: Record<string, string>;
  setMapping: (mapping: Record<string, string>) => void;
  defaultEffort: string;
  setDefaultEffort: (effort: string) => void;
}) {
  const rows = Object.entries(mapping).map(([clientEffort, upstreamEffort]) => ({
    clientEffort,
    upstreamEffort,
  }));
  const exposed = rows.flatMap(({ clientEffort, upstreamEffort }) =>
    clientEffort.trim() && upstreamEffort.trim() ? [clientEffort.trim()] : []
  );
  const updateRow = (index: number, field: "client" | "upstream", value: string) => {
    setMapping(
      Object.fromEntries(
        rows.map((row, rowIndex) =>
          rowIndex === index
            ? [
                field === "client" ? value : row.clientEffort,
                field === "upstream" ? value : row.upstreamEffort,
              ]
            : [row.clientEffort, row.upstreamEffort]
        )
      )
    );
  };

  return (
    <PanelShell
      title="Client-to-provider mapping"
      description={`Map client efforts to values accepted by ${selected?.providerLabel ?? "the provider"}`}
      actions={
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label="Add mapping"
          title="Add mapping"
          disabled={Object.hasOwn(mapping, "")}
          onClick={() => setMapping({ ...mapping, "": "" })}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      }
    >
      <SettingsControlRow
        title="Default reasoning effort"
        description="Used when the client does not provide an effort"
      >
        <Select value={defaultEffort} onValueChange={setDefaultEffort} disabled={!exposed.length}>
          <SelectTrigger aria-label="Default reasoning effort" className="w-full">
            <SelectValue placeholder="Not available" />
          </SelectTrigger>
          <SelectContent>
            {exposed.map((effort) => (
              <SelectItem key={effort} value={effort}>
                {effort}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsControlRow>
      {rows.length ? (
        <>
          <div className="grid grid-cols-2 border-b border-border bg-muted text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <div className="px-3 py-2">Client effort</div>
            <div className="border-l border-border px-3 py-2">Provider effort</div>
          </div>
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((row, index) => (
              <motion.div
                key={`${index}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={RESIZE_TRANSITION}
                className="grid grid-cols-2 border-b border-border last:border-b-0"
              >
                <Input
                  value={row.clientEffort}
                  onChange={(event) => updateRow(index, "client", event.target.value)}
                  aria-label={`Client effort ${index + 1}`}
                  placeholder="ultra"
                  className="h-9 rounded-none border-0 shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                />
                <div className="flex min-w-0 items-center border-l border-border">
                  <Combobox
                    freeText
                    value={row.upstreamEffort}
                    options={(selected?.reasoningEfforts ?? []).map((effort) => ({
                      value: effort,
                      label: effort,
                    }))}
                    onValueChange={(value) => updateRow(index, "upstream", value)}
                    ariaLabel={`Provider effort ${index + 1}`}
                    placeholder="Select or enter an effort"
                    searchPlaceholder="Select or enter an effort"
                    className="min-w-0 flex-1"
                    inputClassName="h-9 rounded-none border-0 shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove reasoning mapping ${index + 1}`}
                    className="h-9 w-9 rounded-none border-l border-border"
                    onClick={() =>
                      setMapping(
                        Object.fromEntries(
                          rows
                            .filter((_, rowIndex) => rowIndex !== index)
                            .map(({ clientEffort, upstreamEffort }) => [
                              clientEffort,
                              upstreamEffort,
                            ])
                        )
                      )
                    }
                  >
                    <Minus />
                  </Button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </>
      ) : (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No reasoning efforts exposed. Use Add mapping to configure one.
        </div>
      )}
    </PanelShell>
  );
}
