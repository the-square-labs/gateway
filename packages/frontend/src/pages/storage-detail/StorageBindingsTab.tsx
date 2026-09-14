import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
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
import { formatDate } from "@/lib/utils";
import { api } from "@/services/api";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { ManagedStorageBinding, ManagedStorageBindingTargetType, Node } from "@/types";

const STATUS_BADGE: Record<ManagedStorageBinding["status"], "success" | "warning" | "destructive"> =
  {
    ready: "success",
    creating: "warning",
    deleting: "warning",
    error: "destructive",
  };

/** Names most S3 SDKs already read, so a bound workload usually needs no code change. */
const DEFAULT_ENVIRONMENT = {
  endpoint: "S3_ENDPOINT",
  accessKeyId: "AWS_ACCESS_KEY_ID",
  secretAccessKey: "AWS_SECRET_ACCESS_KEY",
  bucket: "S3_BUCKET",
  region: "AWS_REGION",
};

/** Field -> the label used when showing which variable carries it. */
const ENVIRONMENT_LABELS: Record<string, string> = {
  endpoint: "Endpoint variable",
  accessKeyId: "Access key variable",
  secretAccessKey: "Secret key variable",
  bucket: "Bucket variable",
  region: "Region variable",
};

interface StorageBindingsTabProps {
  managedId: string;
  canManage: boolean;
}

export function StorageBindingsTab({ managedId, canManage }: StorageBindingsTabProps) {
  const [bindings, setBindings] = useState<ManagedStorageBinding[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [targetNodeId, setTargetNodeId] = useState("");
  const [targetType, setTargetType] = useState<ManagedStorageBindingTargetType>("container");
  const [targetResourceId, setTargetResourceId] = useState("");
  const [buckets, setBuckets] = useState("");
  const [environment, setEnvironment] = useState(DEFAULT_ENVIRONMENT);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBindings(await api.listManagedStorageBindings(managedId));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load bindings");
    } finally {
      setLoading(false);
    }
  }, [managedId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!createOpen) return;
    api
      .listNodes({ type: "docker", limit: 100 })
      .then((result) => setNodes(result.data ?? []))
      .catch(() => setNodes([]));
  }, [createOpen]);

  const resetDraft = () => {
    setTargetNodeId("");
    setTargetType("container");
    setTargetResourceId("");
    setBuckets("");
    setEnvironment(DEFAULT_ENVIRONMENT);
  };

  const create = async () => {
    const bucketList = buckets
      .split(",")
      .map((bucket) => bucket.trim())
      .filter(Boolean);
    setSaving(true);
    try {
      await api.createManagedStorageBinding(managedId, {
        targetNodeId,
        targetType,
        targetResourceId: targetResourceId.trim(),
        environment,
        buckets: bucketList,
      });
      toast.success("Binding created");
      setCreateOpen(false);
      resetDraft();
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create binding";
      if (!handleLicenseApiError(error, "Managed storage")) toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (binding: ManagedStorageBinding) => {
    const confirmed = await confirm({
      title: "Remove binding?",
      description:
        `The connector and its private network are removed from ${binding.targetResourceId}, and the ` +
        `binding's access key is revoked. The workload loses access immediately.`,
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!confirmed) return;
    try {
      await api.deleteManagedStorageBinding(managedId, binding.id);
      toast.success("Binding removed");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove binding");
    }
  };

  const canSubmit =
    targetNodeId.length > 0 &&
    targetResourceId.trim().length > 0 &&
    buckets.trim().length > 0 &&
    Object.values(environment).some(Boolean);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner className="" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          A binding gives one workload a private route to this cluster: a connector sidecar on its
          node, reachable only inside a dedicated network, with its own access key scoped to the
          buckets you choose. There is no link to copy — the endpoint resolves only inside that
          network, and the credentials are written into the workload as Docker secrets.
        </p>
        {canManage && (
          <Button onClick={() => setCreateOpen(true)} className="shrink-0">
            <Plus className="mr-1.5 h-4 w-4" />
            Add binding
          </Button>
        )}
      </div>

      {bindings.length === 0 ? (
        <EmptyState message="No bindings yet. Bind a container or deployment to reach this storage privately." />
      ) : (
        <div className="divide-y divide-border border border-border bg-card">
          {bindings.map((binding) => (
            <div key={binding.id} className="flex items-start justify-between gap-4 p-3">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-sm">{binding.targetResourceId}</span>
                  <Badge variant="secondary">{binding.targetType}</Badge>
                  <Badge variant={STATUS_BADGE[binding.status]}>{binding.status}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {binding.buckets.join(", ")}
                  {" · "}
                  {formatDate(binding.createdAt)}
                </p>
                {/* What the workload actually received. There is no link to
                    copy: the endpoint resolves only inside the binding's
                    private network, and the credential is written straight
                    into the container as a Docker secret. */}
                <dl className="grid grid-cols-[auto,minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                  <dt className="text-muted-foreground">Endpoint</dt>
                  <dd className="truncate font-mono">http://{binding.connectorAlias}:9000</dd>
                  {binding.accessKeyId && (
                    <>
                      <dt className="text-muted-foreground">Access key</dt>
                      <dd className="truncate font-mono">{binding.accessKeyId}</dd>
                    </>
                  )}
                  {Object.entries(binding.environment)
                    .filter(([, name]) => Boolean(name))
                    .map(([field, name]) => (
                      <div key={field} className="contents">
                        <dt className="text-muted-foreground">
                          {ENVIRONMENT_LABELS[field] ?? field}
                        </dt>
                        <dd className="truncate font-mono">{name}</dd>
                      </div>
                    ))}
                </dl>
                {binding.lastError && (
                  <p className="wrap-break-word text-xs text-destructive">{binding.lastError}</p>
                )}
              </div>
              {canManage && (
                <Button
                  variant="ghost"
                  size="icon"
                  title="Remove binding"
                  onClick={() => void remove(binding)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add binding</DialogTitle>
            <DialogDescription>
              The workload reaches the cluster through a connector on its own node. Its access key
              is created here and scoped to the buckets below.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Node</label>
                <Select value={targetNodeId} onValueChange={setTargetNodeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a node" />
                  </SelectTrigger>
                  <SelectContent>
                    {nodes.map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.displayName || node.hostname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Target</label>
                <Select
                  value={targetType}
                  onValueChange={(value) => setTargetType(value as ManagedStorageBindingTargetType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="container">Container</SelectItem>
                    <SelectItem value="deployment">Deployment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {targetType === "deployment" ? "Deployment" : "Container"} name
              </label>
              <Input
                value={targetResourceId}
                onChange={(e) => setTargetResourceId(e.target.value)}
                placeholder="my-app"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Buckets</label>
              <Input
                value={buckets}
                onChange={(e) => setBuckets(e.target.value)}
                placeholder="assets, uploads"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated. The binding's key can only reach these buckets, so a compromised
                workload cannot read the rest of the cluster.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Environment variables</label>
              <div className="grid gap-2 md:grid-cols-2">
                {(
                  [
                    ["endpoint", "Endpoint"],
                    ["accessKeyId", "Access key"],
                    ["secretAccessKey", "Secret key"],
                    ["bucket", "Bucket"],
                    ["region", "Region"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key} className="space-y-1">
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <Input
                      className="font-mono text-xs"
                      value={environment[key]}
                      onChange={(e) => setEnvironment({ ...environment, [key]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Written as Docker secrets, so they stay out of the workload's Environment editor.
                Clear a name to skip that variable.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={saving || !canSubmit}>
              {saving ? "Creating..." : "Create binding"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
