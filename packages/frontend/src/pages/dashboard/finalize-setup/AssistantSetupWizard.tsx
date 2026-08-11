import { ArrowRight, Bot, Cpu, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { FinalizeSetupCompletion } from "./FinalizeSetupCompletion";
import { FinalizeSetupWizardDialog } from "./FinalizeSetupWizardDialog";

export interface AssistantSetupDraft {
  source: "external" | "inference" | null;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const EMPTY_ASSISTANT_SETUP_DRAFT: AssistantSetupDraft = {
  source: null,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
};

type InferenceModelOption = { id: string; displayName: string };

function readInferenceModels(config: Record<string, unknown>): InferenceModelOption[] {
  const value = config.gatewayInferenceModels;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { id?: unknown; displayName?: unknown };
    return typeof candidate.id === "string"
      ? [
          {
            id: candidate.id,
            displayName:
              typeof candidate.displayName === "string" ? candidate.displayName : candidate.id,
          },
        ]
      : [];
  });
}

export function AssistantSetupWizard({
  open,
  draft,
  onDraftChange,
  onBack,
  onConfigured,
  onSkipped,
  onNeedInference,
  allowGatewayInference = true,
  initialStepCanSkip = true,
  completionActionLabel = "Back to checklist",
}: {
  open: boolean;
  draft: AssistantSetupDraft;
  onDraftChange: (draft: AssistantSetupDraft) => void;
  onBack: () => void;
  onConfigured: () => Promise<void>;
  onSkipped: () => Promise<void>;
  onNeedInference: () => void;
  allowGatewayInference?: boolean;
  initialStepCanSkip?: boolean;
  completionActionLabel?: string;
}) {
  const [inferenceModels, setInferenceModels] = useState<InferenceModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    if (!open) setCompleted(false);
  }, [open]);

  useEffect(() => {
    if (!open || draft.source !== "inference") return;
    setLoadingModels(true);
    api
      .getAIConfig()
      .then((config) => {
        const models = readInferenceModels(config);
        setInferenceModels(models);
        if (!draft.model && models[0]) onDraftChange({ ...draft, model: models[0].id });
      })
      .catch((cause) =>
        toast.error(cause instanceof Error ? cause.message : "Failed to load inference models")
      )
      .finally(() => setLoadingModels(false));
  }, [draft, onDraftChange, open]);

  const save = async () => {
    if (!draft.source) return;
    if (
      (draft.source === "external" &&
        (!draft.baseUrl.trim() || !draft.apiKey.trim() || !draft.model.trim())) ||
      (draft.source === "inference" && !draft.model)
    )
      return;
    setSaving(true);
    try {
      await api.updateAIConfig(
        draft.source === "external"
          ? {
              enabled: true,
              providerType: "openai_compatible",
              providerUrl: draft.baseUrl.trim(),
              apiKey: draft.apiKey,
              model: draft.model.trim(),
            }
          : {
              enabled: true,
              providerType: "gateway_inference",
              gatewayInferenceModel: draft.model,
              gatewayInferenceAllowUserModelSelection: true,
            }
      );
      await useAIStore.getState().refreshProviderStatus();
      setCompleted(true);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to configure AI Workspace");
    } finally {
      setSaving(false);
    }
  };

  const setSource = (source: AssistantSetupDraft["source"]) => {
    onDraftChange({ ...draft, source, model: source === "inference" ? draft.model : "" });
  };

  const screen = completed ? "complete" : (draft.source ?? "choice");
  return (
    <FinalizeSetupWizardDialog
      open={open}
      title="Configure AI Workspace"
      description={
        <>
          <p>
            AI Workspace is Gateway's intent-driven operations interface. Describe the outcome you
            want, keep the operational context in one Work Session, and move between guidance and
            Gateway resources without losing your place.
          </p>
          <p>
            Choose an OAI-compatible provider when you already have an OpenAI-compatible endpoint,
            API key, and model that should serve this Gateway. Gateway stores that connection for AI
            Workspace only; it does not expose the provider as a shared model catalog.
          </p>
          {allowGatewayInference && (
            <p>
              Choose Gateway Inference when providers and models should be managed centrally for
              multiple users or features. It requires Inference to have a connected provider and at
              least one enabled model first. You can revise either choice later in Settings.
            </p>
          )}
          <p>
            AI Workspace is recommended, not required. Operations Console keeps every Gateway
            capability available without a model connection.
          </p>
        </>
      }
      stepKey={screen}
      onBack={completed ? undefined : draft.source ? () => setSource(null) : onBack}
      onSkip={completed || (!initialStepCanSkip && draft.source === null) ? undefined : onSkipped}
      skipDisabled={saving}
      footer={
        completed ? (
          <Button onClick={() => void onConfigured()} disabled={saving}>
            <Bot /> {completionActionLabel}
          </Button>
        ) : draft.source ? (
          <Button
            onClick={() => void save()}
            disabled={
              saving ||
              !draft.model ||
              (draft.source === "external" && (!draft.baseUrl.trim() || !draft.apiKey.trim()))
            }
          >
            {saving ? <Loader2 className="animate-spin" /> : <Bot />}
            Save AI Workspace
          </Button>
        ) : null
      }
    >
      {completed ? (
        <FinalizeSetupCompletion
          title="AI Workspace configured"
          continueIn="Continue from Settings → AI Workspace to change its model connection whenever your requirements change."
        >
          Gateway can now use the selected Workspace model while preserving each operator's
          permissions.
        </FinalizeSetupCompletion>
      ) : draft.source === null ? (
        <div className="space-y-3">
          <Button
            variant="outline"
            className="h-auto w-full justify-start whitespace-normal px-4 py-3 text-left"
            onClick={() => setSource("external")}
          >
            <span className="flex w-full items-center gap-3">
              <ExternalLink className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium text-foreground">
                  OAI-compatible provider
                </span>
                <span className="mt-0.5 block text-[13px] font-normal text-muted-foreground">
                  Connect OpenAI or any compatible endpoint with your own API key and model.
                </span>
              </span>
            </span>
          </Button>
          {allowGatewayInference && (
            <Button
              variant="outline"
              className="h-auto w-full justify-start whitespace-normal px-4 py-3 text-left"
              onClick={() => setSource("inference")}
            >
              <span className="flex w-full items-center gap-3">
                <Cpu className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium text-foreground">
                    Gateway Inference
                  </span>
                  <span className="mt-0.5 block text-[13px] font-normal text-muted-foreground">
                    Use centrally managed providers and models that Gateway makes available.
                  </span>
                </span>
              </span>
            </Button>
          )}
        </div>
      ) : draft.source === "external" ? (
        <PanelShell
          title="OAI-compatible provider"
          description="Connect the model provider used only by AI Workspace."
        >
          <SettingsControlRow
            title="Base URL"
            description="The provider's OpenAI-compatible API endpoint."
            controlsClassName="sm:min-w-[18rem]"
          >
            <Input
              value={draft.baseUrl}
              onChange={(event) => onDraftChange({ ...draft, baseUrl: event.target.value })}
              placeholder="https://api.openai.com/v1"
              autoFocus
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="API key"
            description="Stored encrypted and used only for AI Workspace requests."
            controlsClassName="sm:min-w-[18rem]"
          >
            <Input
              type="password"
              value={draft.apiKey}
              onChange={(event) => onDraftChange({ ...draft, apiKey: event.target.value })}
              autoComplete="off"
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Model"
            description="The Workspace model name sent with each request."
            controlsClassName="sm:min-w-[18rem]"
          >
            <Input
              value={draft.model}
              onChange={(event) => onDraftChange({ ...draft, model: event.target.value })}
              placeholder="gpt-4.1-mini"
            />
          </SettingsControlRow>
        </PanelShell>
      ) : loadingModels ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Loader2 className="mr-2 animate-spin" /> Checking Gateway Inference…
        </div>
      ) : inferenceModels.length === 0 ? (
        <div className="space-y-3 border border-warning/60 p-4">
          <div>
            <p className="text-sm font-semibold text-warning">Gateway Inference needs setup</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect a provider and make at least one model available before AI Workspace can use
              Gateway Inference.
            </p>
          </div>
          <button
            type="button"
            className="flex items-center gap-1 text-sm font-medium text-warning hover:underline"
            onClick={onNeedInference}
          >
            Configure Gateway Inference
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <PanelShell
          title="Gateway Inference"
          description="Centrally managed models available to AI Workspace."
        >
          <SettingsControlRow
            title="Default model"
            description="Model used when a Work Session starts. Operators can switch to another allowed model."
            controlsClassName="sm:min-w-[18rem]"
          >
            <Select
              value={draft.model}
              onValueChange={(model) => onDraftChange({ ...draft, model })}
            >
              <SelectTrigger aria-label="Default model" className="text-sm">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {inferenceModels.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsControlRow>
        </PanelShell>
      )}
    </FinalizeSetupWizardDialog>
  );
}
