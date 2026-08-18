import { Pin, PinOff, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { CopyButton } from "@/components/common/CopyButton";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { PageDeployment } from "@/types";
import {
  formatPageBytes,
  formatPageDate,
  pagePreviewUrl,
  pageStatusLabel,
  pageStatusVariant,
} from "./page-format";

export function PageDeploymentsTab({
  projectId,
  onLatestPreviewChange,
}: {
  projectId: string;
  onLatestPreviewChange?: (hostname: string | null) => void;
}) {
  const canManage = useAuthStore((state) =>
    state.hasScopedAccess(`pages:deployments:manage:${projectId}`)
  );
  const [deployments, setDeployments] = useState<PageDeployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDeployment, setSelectedDeployment] = useState<PageDeployment | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const openDetails = (deployment: PageDeployment) => {
    setSelectedDeployment(deployment);
    setDetailsOpen(true);
  };

  const load = useCallback(async () => {
    setLoading((current) => current || deployments.length === 0);
    try {
      const response = await api.listPageDeployments(projectId, { page: 1, limit: 100 });
      const next = response.data ?? [];
      setDeployments(next);
      onLatestPreviewChange?.(
        next.find((deployment) => deployment.status === "ready")?.previewHostname ?? null
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load Deployments");
    } finally {
      setLoading(false);
    }
  }, [deployments.length, onLatestPreviewChange, projectId]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("pages.deployment.changed", (payload) => {
    const event = payload as { projectId?: string };
    if (!event.projectId || event.projectId === projectId) void load();
  });

  const togglePin = async (deployment: PageDeployment) => {
    try {
      await api.pinPageDeployment(projectId, deployment.id, !deployment.pinned);
      setDeployments((current) =>
        current.map((item) =>
          item.id === deployment.id ? { ...item, pinned: !item.pinned } : item
        )
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update Deployment");
    }
  };

  const remove = async (deployment: PageDeployment) => {
    if (
      !(await confirm({
        title: "Delete Deployment",
        description: `Delete immutable Deployment ${deployment.publicSlug}? Protected Deployments explain the exact Tag or Route that still references them.`,
        confirmLabel: "Delete",
        variant: "destructive",
      }))
    ) {
      return;
    }
    try {
      await api.deletePageDeployment(projectId, deployment.id);
      toast.success("Deployment deleted");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete Deployment");
    }
  };

  const columns: SimpleTableColumn<PageDeployment>[] = [
    {
      id: "hash",
      header: "Deployment",
      className: "w-[30%]",
      render: (deployment) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate">{deployment.publicSlug}</span>
          {deployment.pinned && <Badge variant="outline">Pinned</Badge>}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      className: "w-[16%]",
      render: (deployment) => (
        <Badge variant={pageStatusVariant(deployment.status)}>
          {pageStatusLabel(deployment.status)}
        </Badge>
      ),
    },
    {
      id: "created",
      header: "Created",
      className: "w-[22%]",
      render: (deployment) => <span className="whitespace-nowrap">{formatPageDate(deployment.createdAt)}</span>,
    },
    {
      id: "preview",
      header: "Preview",
      className: "w-[22%]",
      cellClassName: "pr-8",
      render: (deployment) => {
        const url = pagePreviewUrl(deployment.previewHostname);
        if (!url) return <Badge variant="secondary">Unavailable</Badge>;
        return (
          <div className="min-w-0" onClick={(event) => event.stopPropagation()}>
            <a
              className="block truncate text-primary underline"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {deployment.previewHostname}
            </a>
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "",
      align: "right",
      className: "w-[10%]",
      render: (deployment) => (
        <div className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          {canManage && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void togglePin(deployment)}
              aria-label={deployment.pinned ? "Unpin Deployment" : "Pin Deployment"}
              title={deployment.pinned ? "Unpin Deployment" : "Pin Deployment"}
            >
              {deployment.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            </Button>
          )}
          {canManage && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void remove(deployment)}
              aria-label="Delete Deployment"
              title="Delete Deployment"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  const selectedPreviewUrl = selectedDeployment
    ? pagePreviewUrl(selectedDeployment.previewHostname)
    : null;

  return (
    <>
      <PanelShell
        title="Deployments"
        description="Immutable static artifacts and their preview publication status."
      >
        <SimpleTable
          columns={columns}
          rows={deployments}
          getRowKey={(deployment) => deployment.id}
          loading={loading}
          loadingMessage="Loading Deployments"
          emptyMessage="No Deployments yet. Use the resumable webhook API to upload a static artifact."
          tableClassName="table-fixed"
          onRowClick={openDetails}
        />
      </PanelShell>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent
          className="sm:max-w-lg"
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.currentTarget.dataset.state === "closed"
            ) {
              setSelectedDeployment(null);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Deployment details</DialogTitle>
            <DialogDescription>{selectedDeployment?.publicSlug}</DialogDescription>
          </DialogHeader>
          {selectedDeployment && (
            <PanelShell title="Deployment">
              <SettingsControlRow title="Status" controlsClassName="sm:min-w-0">
                <Badge variant={pageStatusVariant(selectedDeployment.status)}>
                  {pageStatusLabel(selectedDeployment.status)}
                </Badge>
              </SettingsControlRow>
              <SettingsControlRow title="Created" controlsClassName="sm:min-w-0">
                <span className="text-sm">{formatPageDate(selectedDeployment.createdAt)}</span>
              </SettingsControlRow>
              <SettingsControlRow title="Artifact" controlsClassName="sm:min-w-0">
                <span className="text-right text-sm">
                  {formatPageBytes(selectedDeployment.compressedSizeBytes)} compressed ·{" "}
                  {selectedDeployment.fileCount.toLocaleString()} files
                </span>
              </SettingsControlRow>
              <SettingsControlRow title="Source" controlsClassName="sm:min-w-0">
                <span className="min-w-0 truncate text-right text-sm">
                  {selectedDeployment.sourceMetadata.mergeRequest ??
                    selectedDeployment.sourceMetadata.commitSha ??
                    selectedDeployment.sourceMetadata.ref ??
                    "Static artifact"}
                </span>
              </SettingsControlRow>
              <SettingsControlRow title="Requested Tag" controlsClassName="sm:min-w-0">
                <span className="text-sm">{selectedDeployment.requestedTag ?? "None"}</span>
              </SettingsControlRow>
              <SettingsControlRow title="Preview" controlsClassName="sm:min-w-0">
                {selectedPreviewUrl ? (
                  <div className="flex min-w-0 items-center gap-1">
                    <a
                      className="truncate text-sm text-primary underline"
                      href={selectedPreviewUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {selectedDeployment.previewHostname}
                    </a>
                    <CopyButton value={selectedPreviewUrl} label="immutable preview URL" />
                  </div>
                ) : (
                  <Badge variant="secondary">Unavailable</Badge>
                )}
              </SettingsControlRow>
              {selectedDeployment.failureMessage && (
                <SettingsControlRow title="Failure" controlsClassName="sm:min-w-0">
                  <span className="text-right text-sm">{selectedDeployment.failureMessage}</span>
                </SettingsControlRow>
              )}
            </PanelShell>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
