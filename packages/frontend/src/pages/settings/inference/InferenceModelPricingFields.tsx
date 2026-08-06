import type { Dispatch, SetStateAction } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Input } from "@/components/ui/input";
import type { ModelPricingForm, ProviderModelOption } from "./inference-model-form";

export function ModelPricingFields({
  selected,
  pricing,
  setPricing,
}: {
  selected: ProviderModelOption;
  pricing: ModelPricingForm;
  setPricing: Dispatch<SetStateAction<ModelPricingForm>>;
}) {
  const managed = selected.pricing;
  const setPrice = <K extends keyof ModelPricingForm>(key: K, value: string) =>
    setPricing((current) => ({ ...current, [key]: value }));

  return (
    <PanelShell
      title="API pricing"
      description={
        managed
          ? `Managed provider pricing · ${managed.version}`
          : "Configure prices in USD; token prices are per one million tokens"
      }
    >
      {managed ? (
        <>
          <ManagedPriceRow
            label="Input tokens"
            microdollars={managed.inputMicrodollarsPerMillion}
          />
          {managed.cachedInputMicrodollarsPerMillion == null ? null : (
            <ManagedPriceRow
              label="Cached input tokens"
              microdollars={managed.cachedInputMicrodollarsPerMillion}
            />
          )}
          {managed.cacheWriteMicrodollarsPerMillion == null ? null : (
            <ManagedPriceRow
              label="Cache write tokens"
              microdollars={managed.cacheWriteMicrodollarsPerMillion}
            />
          )}
          <ManagedPriceRow
            label="Output tokens"
            microdollars={managed.outputMicrodollarsPerMillion}
          />
          {managed.reasoningMicrodollarsPerMillion == null ? null : (
            <ManagedPriceRow
              label="Reasoning tokens"
              microdollars={managed.reasoningMicrodollarsPerMillion}
            />
          )}
          {Object.entries(managed.otherUnitPrices ?? {}).map(([unit, microdollars]) => (
            <ManagedPriceRow key={unit} label={formatUnit(unit)} microdollars={microdollars} />
          ))}
        </>
      ) : (
        <>
          <ManualPriceRow
            label="Input tokens"
            value={pricing.inputPrice}
            onChange={(value) => setPrice("inputPrice", value)}
          />
          <ManualPriceRow
            label="Output tokens"
            value={pricing.outputPrice}
            onChange={(value) => setPrice("outputPrice", value)}
          />
          <ManualPriceRow
            label="Image generation"
            value={pricing.imagePrice}
            unit="USD per operation"
            onChange={(value) => setPrice("imagePrice", value)}
          />
          <ManualPriceRow
            label="Web search"
            value={pricing.searchPrice}
            unit="USD per operation"
            onChange={(value) => setPrice("searchPrice", value)}
          />
          <ManualPriceRow
            label="Realtime session"
            value={pricing.realtimePrice}
            unit="USD per operation"
            onChange={(value) => setPrice("realtimePrice", value)}
          />
        </>
      )}
    </PanelShell>
  );
}

function ManagedPriceRow({ label, microdollars }: { label: string; microdollars: number }) {
  return (
    <SettingsControlRow title={label} description="Provider-managed and read-only">
      <Input
        readOnly
        aria-label={label}
        value={formatPrice(microdollars)}
        className="w-full bg-muted/40 text-muted-foreground"
      />
    </SettingsControlRow>
  );
}

function ManualPriceRow({
  label,
  value,
  onChange,
  unit = "USD per 1M tokens",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  unit?: string;
}) {
  return (
    <SettingsControlRow title={label} description={unit}>
      <Input
        type="number"
        min="0"
        step="0.01"
        value={value}
        aria-label={label}
        className="w-full"
        onChange={(event) => onChange(event.target.value)}
      />
    </SettingsControlRow>
  );
}

function formatPrice(microdollars: number) {
  return `$${(microdollars / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}

function formatUnit(value: string) {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}
