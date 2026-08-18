import { ArrowRightLeft, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { PageDeployment, PageTag } from "@/types";
import { formatPageDate, pageStatusLabel, pageStatusVariant } from "./page-format";

export function PageTagsTab({ projectId }: { projectId: string }) {
  const canManage = useAuthStore((state) =>
    state.hasScopedAccess(`pages:tags:manage:${projectId}`)
  );
  const [tags, setTags] = useState<PageTag[]>([]);
  const [deployments, setDeployments] = useState<PageDeployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tagName, setTagName] = useState("");
  const [deploymentId, setDeploymentId] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading((current) => current || tags.length === 0);
    try {
      const [nextTags, nextDeployments] = await Promise.all([
        api.listPageTags(projectId),
        api.listPageDeployments(projectId, { page: 1, limit: 100 }),
      ]);
      setTags(nextTags);
      setDeployments(nextDeployments.data ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load Tags");
    } finally {
      setLoading(false);
    }
  }, [projectId, tags.length]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("pages.tag.changed", (payload) => {
    const event = payload as { projectId?: string };
    if (!event.projectId || event.projectId === projectId) void load();
  });

  const openCreate = () => {
    if (!deployments.some((deployment) => deployment.status === "ready")) return;
    setTagName("");
    setDeploymentId("");
    setDialogOpen(true);
  };

  const save = async () => {
    if (!tagName.trim() || !deploymentId || saving) return;
    setSaving(true);
    try {
      await api.movePageTag(projectId, tagName.trim().toLowerCase(), deploymentId);
      toast.success("Tag published");
      setDialogOpen(false);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to publish Tag");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (tag: PageTag) => {
    if (tag.system) return;
    if (
      !(await confirm({
        title: "Delete Tag",
        description: `Delete the ${tag.name} Tag? Routes referencing it must be retargeted first.`,
        confirmLabel: "Delete",
        variant: "destructive",
      }))
    ) {
      return;
    }
    try {
      await api.deletePageTag(projectId, tag.name);
      toast.success("Tag deleted");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete Tag");
    }
  };

  const readyDeployments = deployments.filter((deployment) => deployment.status === "ready");

  const columns: SimpleTableColumn<PageTag>[] = [
    {
      id: "tag",
      header: "Tag",
      render: (tag) => (
        <div>
          <span>{tag.name}</span>
          {tag.system && (
            <Badge className="ml-2" variant="secondary">
              System
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "deployment",
      header: "Deployment",
      render: (tag) =>
        tag.deployment ? (
          <div className="flex items-center gap-2">
            <Badge variant="outline">{tag.deployment.publicSlug}</Badge>
            <Badge variant={pageStatusVariant(tag.deployment.status)} size="inline">
              {pageStatusLabel(tag.deployment.status)}
            </Badge>
          </div>
        ) : (
          <Badge variant="secondary">No Deployment</Badge>
        ),
    },
    {
      id: "updated",
      header: "Updated",
      render: (tag) => <span>{formatPageDate(tag.updatedAt)}</span>,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      render: (tag) => (
        <div className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          {canManage && (
            <Button
              variant="ghost"
              size="icon"
              onClick={openCreate}
              disabled={readyDeployments.length === 0}
              aria-label={`Move ${tag.name} Tag`}
            >
              <ArrowRightLeft className="h-4 w-4" />
            </Button>
          )}
          {canManage && !tag.system && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void remove(tag)}
              aria-label={`Delete ${tag.name} Tag`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PanelShell
        title="Tags"
        description="Mutable publication pointers used by Routes."
        actions={
          canManage ? (
            <Button onClick={openCreate} disabled={readyDeployments.length === 0}>
              <ArrowRightLeft className="h-4 w-4" />
              Create or move Tag
            </Button>
          ) : undefined
        }
      >
        <SimpleTable
          columns={columns}
          rows={tags}
          getRowKey={(tag) => tag.id}
          loading={loading}
          loadingMessage="Loading Tags"
          emptyMessage="No user Tags yet. The system-owned latest Tag appears after the first Deployment."
        />
      </PanelShell>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create or move Tag</DialogTitle>
            <DialogDescription>Point a Tag at a ready Deployment.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="page-tag-name" className="text-sm font-medium">
                Tag
              </label>
              <Input
                id="page-tag-name"
                value={tagName}
                onChange={(event) => setTagName(event.target.value.replace(/[^a-z0-9-]/g, ""))}
                placeholder="preview-mr-42"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Target Deployment</label>
              <Select value={deploymentId} onValueChange={setDeploymentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a ready Deployment" />
                </SelectTrigger>
                <SelectContent>
                  {readyDeployments.map((deployment) => (
                    <SelectItem key={deployment.id} value={deployment.id}>
                      {deployment.publicSlug} · {formatPageDate(deployment.createdAt)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={!tagName.trim() || !deploymentId || saving}
            >
              {saving ? "Publishing…" : "Publish Tag"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
