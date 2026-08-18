import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirmAction } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import {
  DEFAULT_PROXY_UPSTREAM,
  isProxyUpstreamValid,
  ProxyUpstreamFields,
  type ProxyUpstreamSelection,
} from "@/components/proxy/ProxyUpstreamEditor";
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
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import type { DockerContainer, ProxyAdditionalSecureLink } from "@/types";

const EMPTY_SELECTION: ProxyUpstreamSelection = {
  ...DEFAULT_PROXY_UPSTREAM,
  kind: "docker_container",
};

export function AdditionalSecureLinkBindings({
  hostId,
  canManage,
}: {
  hostId: string;
  canManage: boolean;
}) {
  const [bindings, setBindings] = useState<ProxyAdditionalSecureLink[] | null>(null);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [selection, setSelection] = useState<ProxyUpstreamSelection>(EMPTY_SELECTION);
  const [pending, setPending] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const hiddenBindingIds = useRef(new Set<string>());

  const load = useCallback(async () => {
    const [nextBindings, nextContainers] = await Promise.all([
      api.listProxyAdditionalSecureLinks(hostId),
      api.listDockerContainerSnapshots(),
    ]);
    setBindings(
      nextBindings.filter(
        (binding) =>
          binding.status !== "cleanup_pending" && !hiddenBindingIds.current.has(binding.id)
      )
    );
    setContainers(nextContainers);
  }, [hostId]);

  useEffect(() => {
    void load().catch((error) => {
      setBindings([]);
      toast.error(
        error instanceof Error ? error.message : "Failed to load additional Secure Links"
      );
    });
  }, [load]);
  useRealtime("proxy.secure-link.changed", load);
  useRealtime("docker.snapshot.changed", load);
  useRealtime("docker.deployment.changed", load);

  const validName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name);
  const canProvision =
    validName &&
    (selection.kind === "docker_container" || selection.kind === "docker_deployment") &&
    isProxyUpstreamValid(selection);
  const variableFor = (binding: ProxyAdditionalSecureLink) =>
    `{{additionalSecureLinks.${binding.name}}}`;
  const actionColumnCount = bindings?.some(
    (binding) => binding.purpose === "user_managed" && binding.status === "failed"
  )
    ? 2
    : bindings?.some((binding) => binding.purpose === "user_managed" && binding.status === "active")
      ? 1
      : 0;
  const bindingGridTemplate = `minmax(0,9rem) minmax(0,11rem) minmax(0,5rem) minmax(0,5rem) minmax(18rem,1fr) minmax(0,7rem)${
    actionColumnCount > 0 ? ` repeat(${actionColumnCount}, 2.25rem)` : ""
  }`;

  const resetDraft = () => {
    setAdding(false);
    setName("");
    setSelection(EMPTY_SELECTION);
  };

  const provision = async () => {
    if (
      !canProvision ||
      (selection.kind !== "docker_container" && selection.kind !== "docker_deployment")
    )
      return;
    setPending(true);
    try {
      const binding = await api.createProxyAdditionalSecureLink(hostId, {
        name,
        upstreamKind: selection.kind,
        forwardScheme: selection.scheme,
        dockerNodeId: selection.dockerNodeId,
        dockerContainerName: selection.containerName,
        dockerDeploymentId: selection.deploymentId,
        dockerContainerPort: selection.containerPort!,
      });
      setBindings((current) => {
        const existing = current?.findIndex((item) => item.id === binding.id) ?? -1;
        if (existing < 0) return [...(current ?? []), binding];
        const next = [...(current ?? [])];
        next[existing] = binding;
        return next;
      });
      resetDraft();
      if (binding.status === "active") toast.success("Additional Secure Link provisioned");
      else if (binding.status === "failed") {
        toast.error(binding.lastError || "Secure Link provisioning failed");
      } else {
        toast.success("Additional Secure Link provisioning started");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to provision Secure Link");
    } finally {
      setPending(false);
    }
  };

  const retry = async (binding: ProxyAdditionalSecureLink) => {
    setRetryingId(binding.id);
    try {
      const updated = await api.retryProxyAdditionalSecureLink(hostId, binding.id);
      setBindings(
        (current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? [updated]
      );
      if (updated.status === "active") toast.success("Secure Link provisioned");
      else toast.error(updated.lastError || "Secure Link provisioning failed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to retry Secure Link");
    } finally {
      setRetryingId(null);
    }
  };

  const remove = (binding: ProxyAdditionalSecureLink) => {
    void confirmAction(
      {
        title: "Remove additional Secure Link?",
        description: `The binding ${binding.name} will be de-provisioned from both nodes.`,
        confirmLabel: "Remove",
        variant: "destructive",
      },
      async () => {
        let removedIndex = 0;
        hiddenBindingIds.current.add(binding.id);
        setBindings((current) => {
          removedIndex = Math.max(0, current?.findIndex((item) => item.id === binding.id) ?? 0);
          return current?.filter((item) => item.id !== binding.id) ?? [];
        });
        try {
          await api.deleteProxyAdditionalSecureLink(hostId, binding.id);
          toast.success("Additional Secure Link removal started");
          return true;
        } catch (error) {
          hiddenBindingIds.current.delete(binding.id);
          setBindings((current) => {
            if (current?.some((item) => item.id === binding.id)) return current;
            const next = [...(current ?? [])];
            next.splice(removedIndex, 0, binding);
            return next;
          });
          toast.error(error instanceof Error ? error.message : "Failed to remove Secure Link");
          return false;
        }
      }
    );
  };

  return (
    <PanelShell
      title="Additional Secure Link Bindings"
      description="Provision managed upstreams for use in Advanced config"
      className="overflow-visible"
      actions={
        canManage ? (
          <Button onClick={() => setAdding(true)} disabled={pending}>
            <Plus className="h-3.5 w-3.5" /> Add binding
          </Button>
        ) : null
      }
      wrapHeader
    >
      {bindings === null ? null : bindings.length === 0 ? (
        <div className="px-3 py-4 text-sm text-muted-foreground">
          No additional bindings. Provision one to reference it from Advanced config.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[900px]">
            <div
              className="grid border-b border-border bg-muted text-xs font-medium uppercase tracking-wider text-muted-foreground"
              style={{ gridTemplateColumns: bindingGridTemplate }}
            >
              <div className="px-3 py-2">Name</div>
              <div className="border-l border-border px-3 py-2">Resource</div>
              <div className="border-l border-border px-3 py-2">Port</div>
              <div className="border-l border-border px-3 py-2">Scheme</div>
              <div className="border-l border-border px-3 py-2">Variable</div>
              <div className="border-l border-border px-3 py-2 text-center">Status</div>
              {Array.from({ length: actionColumnCount }, (_, index) => (
                <div key={index} className="border-l border-border" />
              ))}
            </div>
            {bindings.map((binding) => (
              <div
                key={binding.id}
                className="grid border-b border-border last:border-b-0"
                style={{ gridTemplateColumns: bindingGridTemplate }}
              >
                <div className="flex min-w-0 items-center px-3 py-2">
                  <p className="truncate text-sm font-medium">
                    {binding.purpose === "additional_route"
                      ? (binding.managedRoutePath ?? "Managed route")
                      : binding.name}
                  </p>
                </div>
                <div
                  className="flex min-w-0 items-center border-l border-border px-3 py-2"
                  title={binding.lastError ?? binding.targetContainer}
                >
                  <p className="truncate text-sm">{binding.targetContainer}</p>
                </div>
                <div className="flex min-w-0 items-center border-l border-border px-3 py-2 text-sm">
                  {binding.dockerContainerPort}
                </div>
                <div className="flex min-w-0 items-center border-l border-border px-3 py-2 text-sm">
                  {binding.forwardScheme.toUpperCase()}
                </div>
                <div className="flex min-w-0 items-center border-l border-border px-3 py-2">
                  {binding.purpose === "additional_route" ? (
                    <p className="truncate text-sm text-muted-foreground">
                      Managed by Additional Route
                    </p>
                  ) : (
                    <p className="truncate font-mono text-xs" title={variableFor(binding)}>
                      {variableFor(binding)}
                    </p>
                  )}
                </div>
                <div className="flex min-h-9 items-stretch border-l border-border">
                  <Badge
                    className="h-full w-full self-stretch justify-center rounded-none"
                    variant={
                      binding.status === "failed"
                        ? "destructive"
                        : binding.status === "active"
                          ? "success"
                          : "secondary"
                    }
                  >
                    {binding.status.replace("_", " ")}
                  </Badge>
                </div>
                {actionColumnCount === 2 &&
                  (binding.purpose === "user_managed" && binding.status === "failed" ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 rounded-none border-l border-border"
                      onClick={() => void retry(binding)}
                      disabled={!canManage || retryingId === binding.id}
                      aria-label={`Retry ${binding.name}`}
                      title="Retry"
                    >
                      {retryingId === binding.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </Button>
                  ) : (
                    <div className="h-9 w-9 border-l border-border" />
                  ))}
                {actionColumnCount >= 1 &&
                  (binding.purpose === "user_managed" &&
                  (binding.status === "active" || binding.status === "failed") ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 rounded-none border-l border-border"
                      onClick={() => remove(binding)}
                      disabled={!canManage}
                      aria-label={`Remove ${binding.name}`}
                      title="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : (
                    <div className="h-9 w-9 border-l border-border" />
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (pending) return;
          if (open) setAdding(true);
          else resetDraft();
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add binding</DialogTitle>
            <DialogDescription>
              Provision another Docker upstream for use in this proxy host's Advanced config.
            </DialogDescription>
          </DialogHeader>
          <div className="border border-border">
            <SettingsControlRow title="Name" description="Variable-safe binding name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="api"
                aria-invalid={name.length > 0 && !validName}
                disabled={pending}
              />
            </SettingsControlRow>
            <ProxyUpstreamFields
              value={selection}
              onChange={setSelection}
              containers={containers}
              disabled={pending}
              allowManual={false}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetDraft} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={provision} disabled={!canProvision || pending}>
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              {pending ? "Provisioning..." : "Provision"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelShell>
  );
}
