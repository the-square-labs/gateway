import { Input } from "@/components/ui/input";

type ResourceKey = "storageSizeGb" | "cpuCores" | "memoryMb" | "swapMb";

export function ManagedResourceFields({
  idPrefix,
  values,
  capacity,
  onChange,
  minimumStorageGb = 0.1,
  minimumMemoryMb,
  memoryHint,
}: {
  idPrefix: string;
  values: Record<ResourceKey, string>;
  capacity: Partial<Record<ResourceKey, number>>;
  onChange: (key: ResourceKey, value: string) => void;
  minimumStorageGb?: number;
  minimumMemoryMb: number;
  memoryHint?: string;
}) {
  return (
    <div className="grid gap-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor={`${idPrefix}-storage`}>
          Storage (GB)
        </label>
        <Input
          id={`${idPrefix}-storage`}
          type="number"
          min={minimumStorageGb}
          step="0.1"
          max={capacity.storageSizeGb}
          value={values.storageSizeGb}
          onChange={(event) => onChange("storageSizeGb", event.target.value)}
        />
        {capacity.storageSizeGb !== undefined && (
          <p className="text-xs text-muted-foreground">
            Maximum available now: {capacity.storageSizeGb} GB
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor={`${idPrefix}-cpu`}>
          CPU cores
        </label>
        <Input
          id={`${idPrefix}-cpu`}
          type="number"
          min="0.25"
          step="0.25"
          max={capacity.cpuCores}
          value={values.cpuCores}
          onChange={(event) => onChange("cpuCores", event.target.value)}
        />
        {capacity.cpuCores !== undefined && (
          <p className="text-xs text-muted-foreground">
            Maximum available: {capacity.cpuCores} cores
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor={`${idPrefix}-memory`}>
          Memory (MB)
        </label>
        <Input
          id={`${idPrefix}-memory`}
          type="number"
          min={minimumMemoryMb}
          step="128"
          max={capacity.memoryMb}
          value={values.memoryMb}
          onChange={(event) => onChange("memoryMb", event.target.value)}
        />
        {capacity.memoryMb !== undefined && (
          <p className="text-xs text-muted-foreground">
            {memoryHint}
            Maximum available now: {capacity.memoryMb} MB
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor={`${idPrefix}-swap`}>
          Swap (MB)
        </label>
        <Input
          id={`${idPrefix}-swap`}
          type="number"
          min="0"
          step="128"
          max={capacity.swapMb}
          value={values.swapMb}
          onChange={(event) => onChange("swapMb", event.target.value)}
        />
        {capacity.swapMb !== undefined && (
          <p className="text-xs text-muted-foreground">
            Maximum available now: {capacity.swapMb} MB
          </p>
        )}
      </div>
    </div>
  );
}
