import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getNodeAppearanceColor, NODE_APPEARANCE_COLOR_OPTIONS } from "@/lib/node-appearance";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import type { NodeAppearanceColor, PageProject } from "@/types";

export function PageProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  onProjectChange,
}: {
  project: PageProject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectChange: (project: PageProject) => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [appearanceColor, setAppearanceColor] = useState<NodeAppearanceColor | null>(
    project.appearanceColor
  );
  const [maxDeployments, setMaxDeployments] = useState(String(project.maxDeployments));
  const [storageQuotaGiB, setStorageQuotaGiB] = useState(
    String((project.storageQuotaBytes / 1024 / 1024 / 1024).toFixed(2))
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setDescription(project.description ?? "");
    setAppearanceColor(project.appearanceColor);
    setMaxDeployments(String(project.maxDeployments));
    setStorageQuotaGiB(String((project.storageQuotaBytes / 1024 / 1024 / 1024).toFixed(2)));
  }, [open, project]);

  const save = async () => {
    if (!name.trim() || saving) return;
    const retention = Number(maxDeployments);
    const quotaGiB = Number(storageQuotaGiB);
    if (!Number.isInteger(retention) || retention < 1 || retention > 500) {
      toast.error("Maximum retained Deployments must be between 1 and 500");
      return;
    }
    if (!Number.isFinite(quotaGiB) || quotaGiB < 0.001) {
      toast.error("Project storage quota must be at least 1 MiB");
      return;
    }

    setSaving(true);
    try {
      const updated = await api.updatePageProject(project.id, {
        name: name.trim(),
        description: description.trim() || null,
        appearanceColor,
        maxDeployments: retention,
        storageQuotaBytes: Math.round(quotaGiB * 1024 * 1024 * 1024),
      });
      onProjectChange(updated);
      onOpenChange(false);
      toast.success("Project settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save Project settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            Update project details, retention, and storage quota.
          </DialogDescription>
        </DialogHeader>
        <PanelShell
          icon={<Settings className="h-4 w-4" />}
          title="Project"
          description="Details, appearance, retention, and storage limits."
        >
          <SettingsControlRow title="Project name">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My static site"
            />
          </SettingsControlRow>
          <SettingsControlRow title="Description" description="Optional project context.">
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Static site deployed from GitLab"
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Color"
            description="Used for the Project icon and its Route target badge."
          >
            <div className="w-full space-y-2">
              <div className="grid grid-cols-8 gap-2">
                <button
                  type="button"
                  aria-label="Default color"
                  className={cn(
                    "aspect-square w-full border border-input bg-muted",
                    appearanceColor === null && "border-white"
                  )}
                  style={appearanceColor === null ? { borderColor: "#fff" } : undefined}
                  onClick={() => setAppearanceColor(null)}
                />
                {NODE_APPEARANCE_COLOR_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-label={`${option.label} color`}
                    className={cn(
                      "aspect-square w-full border border-input",
                      option.swatchClassName,
                      appearanceColor === option.value && "border-white"
                    )}
                    style={appearanceColor === option.value ? { borderColor: "#fff" } : undefined}
                    onClick={() => setAppearanceColor(option.value)}
                  />
                ))}
              </div>
              <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                <span>Preview:</span>
                <Badge
                  variant="secondary"
                  size="inline"
                  className={getNodeAppearanceColor(appearanceColor)?.badgeClassName}
                >
                  {name.trim() || project.slug}
                </Badge>
              </div>
            </div>
          </SettingsControlRow>
          <SettingsControlRow
            title="Maximum retained Deployments"
            description="Older unprotected Deployments are removed automatically."
          >
            <Input
              type="number"
              min={1}
              max={500}
              value={maxDeployments}
              onChange={(event) => setMaxDeployments(event.target.value)}
              placeholder="20"
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Project storage quota"
            description="Maximum retained artifact storage in GiB."
          >
            <Input
              type="number"
              min={0.001}
              step={0.01}
              value={storageQuotaGiB}
              onChange={(event) => setStorageQuotaGiB(event.target.value)}
              placeholder="1.00"
            />
          </SettingsControlRow>
        </PanelShell>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!name.trim() || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
