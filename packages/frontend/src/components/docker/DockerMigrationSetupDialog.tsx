import { Loader2, Truck } from "lucide-react";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Node } from "@/types";
import type { MigrationResource } from "./DockerMigrationDialog";

export function DockerMigrationSetupDialog({
  open,
  resource,
  nodes,
  targetNodeId,
  keepSource,
  loadingTargets,
  loadingPreflight,
  onTargetNodeChange,
  onKeepSourceChange,
  onRunPreflight,
  onClose,
}: {
  open: boolean;
  resource: MigrationResource;
  nodes: Node[];
  targetNodeId: string;
  keepSource: boolean;
  loadingTargets: boolean;
  loadingPreflight: boolean;
  onTargetNodeChange: (value: string) => void;
  onKeepSourceChange: (value: boolean) => void;
  onRunPreflight: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Migrate {resource.type}</DialogTitle>
          <DialogDescription>
            Move {resource.displayName} to another Docker node after compatibility checks.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <label htmlFor="migration-target" className="text-sm font-medium">
              Target node
            </label>
            <Select value={targetNodeId} onValueChange={onTargetNodeChange}>
              <SelectTrigger id="migration-target" disabled={loadingTargets || nodes.length === 0}>
                <SelectValue
                  placeholder={loadingTargets ? "Loading nodes..." : "Select a Docker node"}
                />
              </SelectTrigger>
              <SelectContent>
                {nodes.map((node) => (
                  <SelectItem key={node.id} value={node.id}>
                    {node.displayName || node.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!loadingTargets && nodes.length === 0 ? (
              <p className="text-xs text-muted-foreground">No compatible online target nodes.</p>
            ) : null}
          </div>

          <div className="border border-border">
            <SettingsControlRow
              title="Keep source resource"
              description="Leave the source stopped with restart disabled after cutover."
              controlsClassName="sm:min-w-0"
            >
              <Switch
                checked={keepSource}
                onChange={onKeepSourceChange}
                ariaLabel="Keep source resource after migration"
              />
            </SettingsControlRow>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={onRunPreflight}
            disabled={!targetNodeId || loadingTargets || loadingPreflight}
          >
            {loadingPreflight ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Truck className="h-4 w-4" />
            )}
            Run preflight
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
