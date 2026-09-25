import { KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Combobox } from "@/components/common/Combobox";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import type { AccessList, PageProject } from "@/types";

/**
 * Project-wide preview link settings: the access list applied to every preview
 * host (saved with the dialog) and an immediate rotation of every preview link.
 */
export function PagePreviewLinksPanel({
  project,
  accessListId,
  onAccessListChange,
  onProjectChange,
  disabled,
}: {
  project: PageProject;
  accessListId: string;
  onAccessListChange: (accessListId: string) => void;
  onProjectChange: (project: PageProject) => void;
  disabled?: boolean;
}) {
  const [accessLists, setAccessLists] = useState<AccessList[]>([]);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listAccessLists({ limit: 100 })
      .then((response) => {
        if (!cancelled) setAccessLists(response.data ?? []);
      })
      .catch(() => {
        // Without acl:view the selector keeps the current value only.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = [
    { value: "", label: "None (public previews)" },
    ...accessLists.map((list) => ({ value: list.id, label: list.name })),
    ...(accessListId && !accessLists.some((list) => list.id === accessListId)
      ? [{ value: accessListId, label: "Current access list" }]
      : []),
  ];

  const rotate = async () => {
    if (
      !(await confirm({
        title: "Rotate preview links",
        description:
          "Every current Deployment and Tag preview link of this Project stops working at once and new links are published. Custom-domain Routes are not affected.",
        confirmLabel: "Rotate links",
        variant: "destructive",
      }))
    ) {
      return;
    }
    setRotating(true);
    try {
      const result = await api.rotatePagePreviewHash(project.id);
      onProjectChange(result.project);
      const { cleanupPendingHostnames, republishFailures } = result.rotation;
      if (cleanupPendingHostnames > 0 || republishFailures > 0) {
        toast.warning(
          "Preview links rotated. Some old links are revoked once the Nginx node is reachable, and new links are retried automatically."
        );
      } else {
        toast.success("Preview links rotated");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to rotate preview links");
    } finally {
      setRotating(false);
    }
  };

  return (
    <PanelShell
      icon={<KeyRound className="h-4 w-4" />}
      title="Preview links"
      description="Protection and rotation of every Deployment and Tag preview link."
      className="overflow-visible"
    >
      <SettingsControlRow
        title="Access list"
        description="IP rules and basic authentication applied to every preview host of this Project."
        help="Uses the same reusable Access Lists as proxy hosts. Requires an up-to-date Nginx daemon; custom-domain Routes keep their own access list."
      >
        <Combobox
          value={accessListId}
          options={options}
          onValueChange={onAccessListChange}
          placeholder="None (public previews)"
          searchPlaceholder="Search access lists..."
          emptyMessage="No access lists found."
          disabled={disabled}
          ariaLabel="Preview access list"
          className="w-full"
        />
      </SettingsControlRow>
      <SettingsControlRow
        title="Rotate links"
        description="Replace every preview link at once, for example after a link leaked."
      >
        <Button
          variant="outline"
          onClick={() => void rotate()}
          disabled={disabled || rotating}
          aria-label="Rotate preview links"
        >
          <RefreshCw className="h-4 w-4" />
          {rotating ? "Rotating…" : "Rotate links"}
        </Button>
      </SettingsControlRow>
    </PanelShell>
  );
}
