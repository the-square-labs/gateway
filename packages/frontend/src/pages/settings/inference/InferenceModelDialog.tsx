import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/services/api";
import type { PermissionGroup, User } from "@/types";
import type {
  InferenceAccessSubject,
  InferenceModel,
  InferenceProviderCatalogItem,
  InferenceProviderConnection,
} from "@/types/inference";
import { ModelAccessFields, ModelGeneralFields } from "./InferenceModelFormFields";
import { ModelPricingFields } from "./InferenceModelPricingFields";
import { ModelReasoningFields } from "./InferenceModelReasoningFields";
import {
  buildProviderModelOptions,
  defaultReasoningMap,
  EMPTY_MODEL_FORM,
  EMPTY_MODEL_PRICING,
  exposedReasoningEfforts,
  formFromModel,
  formWithProviderModel,
  hasCompletePricing,
  hasCompleteTechnicalLimits,
  manualMetadataForProviderModel,
  modelTechnicalLimits,
  normalizeReasoningMap,
  parsePositiveNumber,
  pricingFromModel,
  pricingFromProvider,
  pricingPayload,
  providerModelKey,
} from "./inference-model-form";

interface Props {
  open: boolean;
  editing: InferenceModel | null;
  connections: InferenceProviderConnection[];
  catalog: InferenceProviderCatalogItem[];
  groups: PermissionGroup[];
  users: User[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}

export function InferenceModelDialog({
  open,
  editing,
  connections,
  catalog,
  groups,
  users,
  onOpenChange,
  onSaved,
}: Props) {
  const options = useMemo(
    () => buildProviderModelOptions(connections, catalog),
    [catalog, connections]
  );
  const [form, setForm] = useState(EMPTY_MODEL_FORM);
  const [providerId, setProviderId] = useState("");
  const [remoteModelId, setRemoteModelId] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [defaultEffort, setDefaultEffort] = useState("");
  const [pricing, setPricing] = useState(EMPTY_MODEL_PRICING);
  const [accessMode, setAccessMode] = useState<"everyone" | "selected" | "disabled">("everyone");
  const [accessSubjects, setAccessSubjects] = useState<InferenceAccessSubject[]>([]);
  const [saving, setSaving] = useState(false);
  const initializedForOpen = useRef(false);
  const selected =
    options.find((option) => option.key === providerModelKey(providerId, remoteModelId)) ?? null;

  useEffect(() => {
    if (!open) {
      initializedForOpen.current = false;
      return;
    }
    if (initializedForOpen.current) return;
    initializedForOpen.current = true;
    const firstSource = editing?.sources[0];
    const nextProviderId = firstSource?.providerId ?? "";
    const nextRemoteModelId = firstSource?.upstreamModelId ?? "";
    const option = options.find(
      (candidate) => candidate.key === providerModelKey(nextProviderId, nextRemoteModelId)
    );
    setProviderId(nextProviderId);
    setRemoteModelId(nextRemoteModelId);
    const baseForm = editing ? formFromModel(editing) : EMPTY_MODEL_FORM;
    setForm(option ? formWithProviderModel(baseForm, option) : baseForm);
    const nextMapping = defaultReasoningMap(
      option?.reasoningEfforts ?? [],
      firstSource?.reasoningEffortMap ?? {}
    );
    setMapping(nextMapping);
    const exposed = exposedReasoningEfforts(nextMapping);
    setDefaultEffort(
      editing?.defaultReasoningEffort && exposed.includes(editing.defaultReasoningEffort)
        ? editing.defaultReasoningEffort
        : exposed.includes("high")
          ? "high"
          : (exposed[0] ?? "")
    );
    setPricing(editing ? pricingFromModel(editing) : pricingFromProvider(option?.pricing));
    setAccessMode(editing?.accessMode ?? "everyone");
    setAccessSubjects(editing?.accessSubjects ?? []);
  }, [editing, open, options]);

  const changeProvider = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    setRemoteModelId("");
    setMapping({});
    setDefaultEffort("");
    setPricing(EMPTY_MODEL_PRICING);
  };

  const changeModel = (nextRemoteModelId: string) => {
    const option = options.find(
      (candidate) => candidate.key === providerModelKey(providerId, nextRemoteModelId)
    );
    if (!option) return;
    setRemoteModelId(nextRemoteModelId);
    setForm((current) => formWithProviderModel(current, option, !editing));
    const nextMapping = defaultReasoningMap(option.reasoningEfforts, {});
    setMapping(nextMapping);
    const exposed = exposedReasoningEfforts(nextMapping);
    setDefaultEffort(exposed.includes("high") ? "high" : (exposed[0] ?? ""));
    setPricing(pricingFromProvider(option.pricing));
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const normalizedMapping = normalizeReasoningMap(mapping);
      const efforts = exposedReasoningEfforts(normalizedMapping);
      const limits = modelTechnicalLimits(form);
      const manualMetadata = manualMetadataForProviderModel(form, selected);
      const subscriptionMultiplier = parsePositiveNumber(form.subscriptionMultiplier);
      if (subscriptionMultiplier === null || !hasCompletePricing(pricing)) return;
      const payload = {
        publicId: form.publicId.trim(),
        displayName: form.displayName.trim(),
        ...limits,
        modalities: selected.modalities,
        capabilities: {
          ...selected.capabilities,
          reasoning: selected.capabilities.reasoning === true && efforts.length > 0,
        },
        reasoningEfforts: efforts,
        defaultReasoningEffort: efforts.includes(defaultEffort) ? defaultEffort : null,
        defaultAccessAllowed: accessMode === "everyone",
        subscriptionMultiplier,
      };
      await api.saveInferenceModelConfiguration(editing?.id ?? null, {
        model: payload,
        sources: selected.bindings.map((binding) => ({
          connectionId: binding.connection.id,
          discoveredModelId: binding.model.id,
          enabled: true,
          reasoningEffortMap: normalizedMapping,
          ...(manualMetadata ? { manualMetadata } : {}),
          ...(selected.sourceType === "api" && !selected.pricing
            ? { pricing: pricingPayload(pricing) }
            : {}),
        })),
        access: {
          mode: accessMode,
          subjects: accessMode === "selected" ? accessSubjects : [],
        },
      });
      onOpenChange(false);
      await onSaved();
      toast.success(editing ? "Inference model updated" : "Inference model added");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save inference model");
    } finally {
      setSaving(false);
    }
  };

  const exposed = exposedReasoningEfforts(mapping);
  const valid = Boolean(
    selected &&
      form.publicId.trim() &&
      form.displayName.trim() &&
      parsePositiveNumber(form.subscriptionMultiplier) !== null &&
      hasCompleteTechnicalLimits(form) &&
      selected.bindings.length > 0 &&
      (accessMode !== "selected" ||
        (accessSubjects.length > 0 && accessSubjects.every((subject) => subject.subjectId))) &&
      hasCompletePricing(pricing) &&
      Object.entries(mapping).every(
        ([clientEffort, upstreamEffort]) => clientEffort.trim() && upstreamEffort.trim()
      ) &&
      (!exposed.length || exposed.includes(defaultEffort))
  );
  const showPricing = selected?.sourceType === "api";
  const showReasoning = selected?.capabilities.reasoning === true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent clipOverflow className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit inference model" : "Add inference model"}</DialogTitle>
          <DialogDescription>
            Choose one provider model. Gateway routes requests only across its eligible accounts.
          </DialogDescription>
        </DialogHeader>

        <AnimatedHeight>
          <Tabs defaultValue="model">
            <TabsList>
              <TabsTrigger value="model">Model</TabsTrigger>
              {showPricing && <TabsTrigger value="pricing">Pricing</TabsTrigger>}
              {showReasoning && <TabsTrigger value="reasoning">Reasoning</TabsTrigger>}
              <TabsTrigger value="access">Access</TabsTrigger>
            </TabsList>
            <TabsContent value="model">
              <ModelGeneralFields
                form={form}
                setForm={setForm}
                options={options}
                providerId={providerId}
                remoteModelId={remoteModelId}
                selected={selected}
                onProviderChange={changeProvider}
                onModelChange={changeModel}
              />
            </TabsContent>
            {showPricing && selected ? (
              <TabsContent value="pricing">
                <ModelPricingFields selected={selected} pricing={pricing} setPricing={setPricing} />
              </TabsContent>
            ) : null}
            {showReasoning ? (
              <TabsContent value="reasoning">
                <ModelReasoningFields
                  selected={selected}
                  mapping={mapping}
                  setMapping={setMapping}
                  defaultEffort={defaultEffort}
                  setDefaultEffort={setDefaultEffort}
                />
              </TabsContent>
            ) : null}
            <TabsContent value="access">
              <ModelAccessFields
                mode={accessMode}
                setMode={setAccessMode}
                subjects={accessSubjects}
                setSubjects={setAccessSubjects}
                groups={groups}
                users={users}
              />
            </TabsContent>
          </Tabs>
        </AnimatedHeight>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!valid || saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {editing ? "Save model" : "Add model"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
