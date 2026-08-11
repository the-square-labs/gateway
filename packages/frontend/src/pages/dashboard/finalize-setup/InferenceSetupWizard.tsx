import { Check, Cpu, Info, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { InferenceProviderConnectDialog } from "@/pages/settings/inference/InferenceProviderConnectDialog";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { useSystemConfigStore } from "@/stores/system-config";
import type {
  InferenceLimitInput,
  InferenceModel,
  InferenceProviderCatalogItem,
  InferenceProviderConnection,
} from "@/types/inference";
import { FinalizeSetupCompletion } from "./FinalizeSetupCompletion";
import { FinalizeSetupWizardDialog } from "./FinalizeSetupWizardDialog";

type SourceOption = {
  key: string;
  connection: InferenceProviderConnection;
  model: NonNullable<InferenceProviderConnection["discoveredModels"]>[number];
};

// The guided setup enables subscription-backed providers without imposing a
// spending cap. API-backed sources remain disabled until an administrator
// explicitly configures an API budget in Gateway Inference settings.
const ONBOARDING_DEFAULT_LIMITS: InferenceLimitInput = {
  enabled: true,
  credits5hEnabled: false,
  credits5h: 0,
  credits7dEnabled: false,
  credits7d: 0,
  credits30dEnabled: false,
  credits30d: 0,
  apiMonthlyMicrodollars: 0,
  billingTimezone: "UTC",
};

function selectableModel(models: InferenceModel[]) {
  return models.some((model) => model.enabled && model.defaultAccessAllowed);
}

function publicId(value: string) {
  return (
    value
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 128) || "gateway-model"
  );
}

export function InferenceSetupWizard({
  open,
  onBack,
  onConfigured,
  onSkipped,
  completionActionLabel = "Back to checklist",
}: {
  open: boolean;
  onBack: () => void;
  onConfigured: () => Promise<void>;
  onSkipped: () => Promise<void>;
  completionActionLabel?: string;
}) {
  const systemConfig = useSystemConfigStore((state) => state.config);
  const setSystemConfig = useSystemConfigStore((state) => state.setConfig);
  const inferenceEnabled = systemConfig.features.inferenceEnabled;
  const [catalog, setCatalog] = useState<InferenceProviderCatalogItem[]>([]);
  const [connections, setConnections] = useState<InferenceProviderConnection[]>([]);
  const [models, setModels] = useState<InferenceModel[]>([]);
  const [providerOpen, setProviderOpen] = useState(false);
  const [selectedSource, setSelectedSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completed, setCompleted] = useState(false);

  const loadInferenceData = useCallback(async () => {
    setLoading(true);
    try {
      const [nextCatalog, nextConnections, nextModels] = await Promise.all([
        api.listInferenceProviderCatalog(),
        api.listInferenceProviderConnections(),
        api.listInferenceModels(),
      ]);
      setCatalog(nextCatalog);
      setConnections(nextConnections);
      setModels(nextModels);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to load Gateway Inference");
    } finally {
      setLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    if (!inferenceEnabled) {
      setCatalog([]);
      setConnections([]);
      setModels([]);
      setLoading(false);
      return;
    }
    await loadInferenceData();
  }, [inferenceEnabled, loadInferenceData]);

  useEffect(() => {
    if (!open) return;
    setProviderOpen(false);
    setSelectedSource("");
    setCompleted(false);
    void load();
  }, [load, open]);

  const sources = useMemo<SourceOption[]>(
    () =>
      connections.flatMap((connection) =>
        connection.discoveredModels
          .filter((model) => model.available)
          .map((model) => ({ key: `${connection.id}:${model.id}`, connection, model }))
      ),
    [connections]
  );
  const selectedModelSource = sources.find((item) => item.key === selectedSource);
  const selectedProvider = selectedModelSource
    ? catalog.find((provider) => provider.id === selectedModelSource.connection.providerId)
    : null;
  const selectedSourceNeedsPricing =
    selectedModelSource !== undefined &&
    !(selectedProvider?.subscription && selectedModelSource.connection.authType === "oauth");
  const selectedSourceHasPricing = selectedModelSource?.model.pricing != null;

  const ensureDefaultLimits = async () => {
    const policies = await api.listInferenceLimits();
    if (!policies.some((policy) => policy.policyType === "default")) {
      return api.setInferenceDefaultLimits(ONBOARDING_DEFAULT_LIMITS);
    }
    return policies;
  };

  const configureAIWorkspace = async (defaultModel: InferenceModel) => {
    await ensureDefaultLimits();
    await api.updateAIConfig({
      enabled: true,
      providerType: "gateway_inference",
      gatewayInferenceModel: defaultModel.publicId,
      gatewayInferenceAllowUserModelSelection: true,
    });
    await useAIStore.getState().refreshProviderStatus();
  };

  const enable = async () => {
    setSaving(true);
    try {
      const settings = await api.getAuthProvisioningSettings();
      const updated = await api.updateAuthProvisioningSettings({
        generalSettings: {
          ...settings.generalSettings,
          features: { ...settings.generalSettings.features, inferenceEnabled: true },
        },
      });
      await ensureDefaultLimits();
      setSystemConfig({
        ...systemConfig,
        features: { ...systemConfig.features, ...updated.generalSettings.features },
      });
      // This callback still closes over the pre-enable feature flag. Load the
      // catalog explicitly instead of waiting for the store-driven rerender.
      await loadInferenceData();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to enable Gateway Inference");
    } finally {
      setSaving(false);
    }
  };

  const configureModel = async () => {
    const source = selectedModelSource;
    if (!source) return;
    if (selectedSourceNeedsPricing && !source.model.pricing) {
      toast.error(
        "Gateway could not discover pricing for this API model. Add it from Settings → Inference."
      );
      return;
    }
    setSaving(true);
    try {
      const contextWindow = source.model.contextWindow ?? 128_000;
      const maxInputTokens = source.model.maxInputTokens ?? contextWindow;
      const maxOutputTokens = source.model.maxOutputTokens ?? 8_192;
      await api.saveInferenceModelConfiguration(null, {
        model: {
          publicId: publicId(source.model.remoteModelId),
          displayName: source.model.displayName ?? source.model.remoteModelId,
          contextWindow,
          maxInputTokens,
          maxOutputTokens,
          autoCompactTokenLimit:
            source.model.autoCompactTokenLimit ?? Math.floor(maxInputTokens * 0.8),
          modalities: source.model.modalities,
          capabilities: source.model.capabilities,
          reasoningEfforts: source.model.reasoningEfforts,
          defaultReasoningEffort: source.model.reasoningEfforts.includes("high")
            ? "high"
            : (source.model.reasoningEfforts[0] ?? null),
          defaultAccessAllowed: true,
          subscriptionMultiplier: 1,
        },
        sources: [
          {
            connectionId: source.connection.id,
            discoveredModelId: source.model.id,
            enabled: true,
            reasoningEffortMap: Object.fromEntries(
              source.model.reasoningEfforts.map((effort) => [effort, effort])
            ),
            manualMetadata: {
              contextWindow,
              maxInputTokens,
              maxOutputTokens,
            },
            ...(selectedSourceNeedsPricing ? { pricing: source.model.pricing! } : {}),
          },
        ],
        access: { mode: "everyone", subjects: [] },
      });
      const nextModels = await api.listInferenceModels();
      setModels(nextModels);
      const defaultModel = nextModels.find((model) => model.enabled && model.defaultAccessAllowed);
      if (defaultModel) {
        await configureAIWorkspace(defaultModel);
        setCompleted(true);
      }
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Failed to configure the inference model"
      );
    } finally {
      setSaving(false);
    }
  };

  const completeSetup = async () => {
    const defaultModel = models.find((model) => model.enabled && model.defaultAccessAllowed);
    if (!defaultModel) return;
    setSaving(true);
    try {
      await configureAIWorkspace(defaultModel);
      setCompleted(true);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to configure AI Workspace");
    } finally {
      setSaving(false);
    }
  };

  const ready = selectableModel(models);
  return (
    <>
      <FinalizeSetupWizardDialog
        open={open && !providerOpen}
        title="Configure Gateway Inference"
        description={
          <>
            <p>
              Gateway Inference is the managed routing layer for AI models. It connects model
              providers once, discovers their available models, and gives Gateway a controlled
              catalog instead of putting separate provider credentials into every feature.
            </p>
            <p>
              After enabling it, you connect a provider, choose the models Gateway may expose, and
              define who can use them. AI Workspace can then use one of those centrally managed
              models, and future Gateway features can use the same approved catalog.
            </p>
            <p>
              Enabling Inference does not contact a provider or make a model available by itself.
              Those happen only in the next steps. It is optional, and all providers, models, and
              access rules remain editable later in Settings.
            </p>
          </>
        }
        stepKey={
          completed
            ? "complete"
            : ready
              ? "ready"
              : !inferenceEnabled
                ? "enable"
                : sources.length
                  ? "model"
                  : "provider"
        }
        onBack={completed ? undefined : onBack}
        onSkip={inferenceEnabled && !completed ? onSkipped : undefined}
        skipDisabled={saving}
        footer={
          completed ? (
            <Button onClick={() => void onConfigured()} disabled={saving}>
              <Check /> {completionActionLabel}
            </Button>
          ) : !inferenceEnabled ? (
            <Button onClick={() => void enable()} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Cpu />} Enable Inference
            </Button>
          ) : sources.length > 0 && !ready ? (
            <Button
              onClick={() => void configureModel()}
              disabled={
                saving ||
                !selectedSource ||
                (selectedSourceNeedsPricing && !selectedSourceHasPricing)
              }
            >
              {saving ? <Loader2 className="animate-spin" /> : <Plus />} Add model
            </Button>
          ) : ready ? (
            <Button onClick={() => void completeSetup()} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Check />} Complete Inference setup
            </Button>
          ) : null
        }
      >
        {completed ? (
          <FinalizeSetupCompletion
            title="AI Workspace is ready"
            continueIn="Continue from Settings → Inference to connect more providers, configure models, and refine access rules."
          >
            Gateway Inference is configured, and AI Workspace will use the selected managed model.
          </FinalizeSetupCompletion>
        ) : loading ? (
          <div className="space-y-4" aria-busy="true" aria-label="Loading Gateway Inference">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <div className="border border-border p-4 space-y-3">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
        ) : !inferenceEnabled ? (
          <div
            className="flex items-center gap-3 border p-4"
            style={{
              borderColor: "color-mix(in srgb, var(--color-link) 55%, transparent)",
            }}
          >
            <Info className="h-5 w-5 shrink-0 text-[color:var(--color-link)]" />
            <div>
              <p className="text-sm font-medium text-[color:var(--color-link)]">
                Inference is disabled
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Enable it to connect providers centrally and make selected models available to
                Gateway users.
              </p>
            </div>
          </div>
        ) : ready ? (
          <div className="border border-border p-4 text-sm text-muted-foreground">
            Gateway has{" "}
            {models.filter((model) => model.enabled && model.defaultAccessAllowed).length}{" "}
            selectable model
            {models.filter((model) => model.enabled && model.defaultAccessAllowed).length === 1
              ? ""
              : "s"}
            . You can manage providers and models later in Settings → Inference.
          </div>
        ) : sources.length === 0 ? (
          <PanelShell
            title="Inference providers"
            description="Connected providers are the source for models Gateway can manage."
          >
            <EmptyState
              embedded
              message="No inference providers connected."
              actionLabel="Connect provider"
              onAction={() => setProviderOpen(true)}
            />
          </PanelShell>
        ) : (
          <PanelShell
            title="Gateway model"
            description="Choose the first model Gateway will make available through its managed catalog."
          >
            <SettingsControlRow
              title="Default model"
              description="Enabled for all Gateway users until you refine access in Settings."
              controlsClassName="sm:w-full sm:min-w-0 sm:max-w-[20rem]"
            >
              <Select value={selectedSource} onValueChange={setSelectedSource}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a discovered model" />
                </SelectTrigger>
                <SelectContent>
                  {sources.map((source) => (
                    <SelectItem key={source.key} value={source.key}>
                      {source.connection.name} ·{" "}
                      {source.model.displayName ?? source.model.remoteModelId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsControlRow>
            {selectedSourceNeedsPricing && !selectedSourceHasPricing && (
              <div className="px-4 py-3">
                <p className="text-xs text-warning">
                  Gateway could not discover pricing for this API model. Add its pricing in Settings
                  → Gateway Inference, or select another model.
                </p>
              </div>
            )}
          </PanelShell>
        )}
      </FinalizeSetupWizardDialog>
      <InferenceProviderConnectDialog
        open={open && providerOpen}
        catalog={catalog}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setProviderOpen(false);
        }}
        onConnected={async () => {
          setProviderOpen(false);
          await load();
        }}
        locked
        onBack={() => setProviderOpen(false)}
      />
    </>
  );
}
