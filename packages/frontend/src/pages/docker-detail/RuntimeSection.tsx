import { Save } from "lucide-react";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow, SettingsInlineControl } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn, formatBytes } from "@/lib/utils";

export interface RuntimeFieldErrors {
  memoryMB?: boolean;
  memSwapMB?: boolean;
  cpuCount?: boolean;
}

interface RuntimeSectionProps {
  canEdit: boolean;
  appliesLive: boolean;
  restartPolicy: string;
  setRestartPolicy: (v: string) => void;
  maxRetries: string;
  setMaxRetries: (v: string) => void;
  memoryMB: string;
  setMemoryMB: (v: string) => void;
  memoryReservationMB?: string;
  memSwapMB: string;
  setMemSwapMB: (v: string) => void;
  cpuCount: string;
  setCpuCount: (v: string) => void;
  cpuShares: string;
  setCpuShares: (v: string) => void;
  pidsLimit: string;
  setPidsLimit: (v: string) => void;
  maxMemoryBytes: number | null;
  maxSwapBytes: number | null;
  maxCpuCount: number | null;
  runtimeValidationError: string | null;
  runtimeFieldErrors: RuntimeFieldErrors;
  hasRuntimeChanges: boolean;
  liveLoading: boolean;
  onApply: () => void;
}

const invalidInputClass =
  "border-destructive ring-1 ring-inset ring-destructive transition-[border-color,box-shadow] focus-visible:border-destructive focus-visible:ring-destructive";

export function RuntimeSection({
  canEdit,
  appliesLive,
  restartPolicy,
  setRestartPolicy,
  maxRetries,
  setMaxRetries,
  memoryMB,
  setMemoryMB,
  memoryReservationMB,
  memSwapMB,
  setMemSwapMB,
  cpuCount,
  setCpuCount,
  cpuShares,
  setCpuShares,
  pidsLimit,
  setPidsLimit,
  maxMemoryBytes,
  maxSwapBytes,
  maxCpuCount,
  runtimeValidationError,
  runtimeFieldErrors,
  hasRuntimeChanges,
  liveLoading,
  onApply,
}: RuntimeSectionProps) {
  const activeFieldErrors = hasRuntimeChanges ? runtimeFieldErrors : {};

  return (
    <PanelShell
      title="Runtime Settings"
      description={
        appliesLive ? "Applied instantly without restart" : "Saved with container configuration"
      }
      actions={
        canEdit ? (
          <Button
            onClick={onApply}
            disabled={liveLoading || !hasRuntimeChanges || !!runtimeValidationError}
          >
            <Save className="h-3.5 w-3.5" />
            {appliesLive ? "Apply" : "Save"}
          </Button>
        ) : null
      }
      bodyClassName="divide-y divide-border"
    >
      <SettingsControlRow title="Restart Policy" description="Container restart behavior">
        <div className="grid w-full gap-2 sm:grid-cols-2">
          <SettingsInlineControl label="Policy">
            <Select value={restartPolicy} onValueChange={setRestartPolicy} disabled={!canEdit}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no">No</SelectItem>
                <SelectItem value="always">Always</SelectItem>
                <SelectItem value="unless-stopped">Unless Stopped</SelectItem>
                <SelectItem value="on-failure">On Failure</SelectItem>
              </SelectContent>
            </Select>
          </SettingsInlineControl>
          <SettingsInlineControl label="Max Retries">
            <Input
              type="number"
              value={maxRetries}
              onChange={(e) => setMaxRetries(e.target.value)}
              placeholder="0"
              disabled={!canEdit || restartPolicy !== "on-failure"}
              min={0}
            />
          </SettingsInlineControl>
        </div>
      </SettingsControlRow>
      <SettingsControlRow title="PID Limits" description="Maximum processes inside the container">
        <SettingsInlineControl label="PIDs Limit">
          <Input
            type="number"
            value={pidsLimit}
            onChange={(e) => setPidsLimit(e.target.value)}
            placeholder="Unlimited"
            disabled={!canEdit}
            min={0}
          />
        </SettingsInlineControl>
      </SettingsControlRow>
      <SettingsControlRow
        title="Memory Limit"
        description={`Max: ${maxMemoryBytes && maxMemoryBytes > 0 ? formatBytes(maxMemoryBytes) : "detecting"}`}
      >
        <SettingsInlineControl label="Memory (MB)">
          <Input
            type="text"
            inputMode="numeric"
            className={cn(activeFieldErrors.memoryMB && invalidInputClass)}
            value={memoryMB}
            onChange={(e) => setMemoryMB(e.target.value)}
            placeholder="Unlimited"
            disabled={!canEdit}
          />
        </SettingsInlineControl>
      </SettingsControlRow>
      {memoryReservationMB !== undefined ? (
        <SettingsControlRow
          title="Memory Reservation"
          description="Soft memory reservation from the Compose service configuration"
        >
          <SettingsInlineControl label="Reservation (MB)">
            <Input value={memoryReservationMB} placeholder="Not set" disabled />
          </SettingsInlineControl>
        </SettingsControlRow>
      ) : null}
      <SettingsControlRow
        title="Swap Limit"
        description={`Max: ${maxSwapBytes !== null && maxSwapBytes >= 0 ? formatBytes(maxSwapBytes) : "detecting"}`}
      >
        <SettingsInlineControl label="Swap (MB)">
          <Input
            type="text"
            inputMode="numeric"
            className={cn(activeFieldErrors.memSwapMB && invalidInputClass)}
            value={memSwapMB}
            onChange={(e) => setMemSwapMB(e.target.value)}
            placeholder="-1 = unlimited, 0 = off"
            disabled={!canEdit}
          />
        </SettingsInlineControl>
      </SettingsControlRow>
      <SettingsControlRow
        title="CPU Limit and Shares"
        description={maxCpuCount && maxCpuCount > 0 ? `Max: ${maxCpuCount} cores` : undefined}
      >
        <div className="grid w-full gap-2 sm:grid-cols-2">
          <SettingsInlineControl label="CPU Limit">
            <Input
              type="number"
              className={cn(activeFieldErrors.cpuCount && invalidInputClass)}
              value={cpuCount}
              onChange={(e) => setCpuCount(e.target.value)}
              placeholder="Unlimited"
              disabled={!canEdit}
              min={0}
              max={maxCpuCount ?? undefined}
              step={0.1}
            />
          </SettingsInlineControl>
          <SettingsInlineControl label="CPU Shares">
            <Input
              type="number"
              value={cpuShares}
              onChange={(e) => setCpuShares(e.target.value)}
              placeholder="Default: 1024"
              disabled={!canEdit}
              min={0}
            />
          </SettingsInlineControl>
        </div>
      </SettingsControlRow>
    </PanelShell>
  );
}
