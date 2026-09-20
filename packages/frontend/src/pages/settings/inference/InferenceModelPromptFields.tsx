import { ScrollText } from "lucide-react";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export type ModelSystemPromptMode = "append" | "replace";

export const MODEL_SYSTEM_PROMPT_MAX_LENGTH = 32_000;

export function ModelPromptFields({
  prompt,
  setPrompt,
  mode,
  setMode,
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  mode: ModelSystemPromptMode;
  setMode: (value: ModelSystemPromptMode) => void;
}) {
  return (
    <PanelShell
      title="System prompt"
      description="Instructions the Codex harness uses for this model"
      icon={<ScrollText className="h-4 w-4" />}
    >
      <SettingsControlRow
        title="Delivery mode"
        description="How the prompt combines with the harness default"
        help="Append keeps the Codex default instructions, including its tool and patch format rules, and adds this prompt after them. Replace substitutes the default entirely; tool use may degrade if the replacement omits those rules. The prompt reaches a device on its next catalog refresh and Codex restart."
      >
        <Select value={mode} onValueChange={(value) => setMode(value as ModelSystemPromptMode)}>
          <SelectTrigger aria-label="System prompt delivery mode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="append">Append to harness default</SelectItem>
            <SelectItem value="replace">Replace harness default</SelectItem>
          </SelectContent>
        </Select>
      </SettingsControlRow>
      <Textarea
        aria-label="Model system prompt"
        className="min-h-[16rem] resize-none border-0"
        placeholder="Leave empty to use the harness default instructions."
        maxLength={MODEL_SYSTEM_PROMPT_MAX_LENGTH}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
    </PanelShell>
  );
}
