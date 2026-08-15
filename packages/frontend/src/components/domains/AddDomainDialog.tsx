import { AnimatePresence, motion } from "framer-motion";
import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { ResourceFolderTreeNode } from "@/types";
import type {
  DomainDnsConflictDetails,
  DomainNginxNodeOptions,
  DomainPreview,
} from "@/types/domains";

const PREVIEW_ANIMATION = {
  initial: { height: 0, opacity: 0, y: 8 },
  animate: { height: "auto", opacity: 1, y: 0 },
  exit: { height: 0, opacity: 0, y: 8 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] },
} as const;

interface AddDomainDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  dnsProvider: "cloudflare" | "external";
}

export function AddDomainDialog({
  open,
  onOpenChange,
  onCreated,
  dnsProvider,
}: AddDomainDialogProps) {
  const [domain, setDomain] = useState("");
  const [description, setDescription] = useState("");
  const [folderId, setFolderId] = useState("");
  const [ttl, setTtl] = useState("1");
  const [proxied, setProxied] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [preview, setPreview] = useState<DomainPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [nodeOptions, setNodeOptions] = useState<DomainNginxNodeOptions | null>(null);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [nodesError, setNodesError] = useState<string | null>(null);
  const [nginxNodeId, setNginxNodeId] = useState("");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const domainFolders = useResourceFolderStore((state) => state.foldersByType.domain);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType.domain);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const folderList = useMemo(() => flattenFolders(domainFolders), [domainFolders]);
  const selectedNginxNode = nodeOptions?.eligibleNodes.find((node) => node.id === nginxNodeId);

  const resetForm = () => {
    setDomain("");
    setDescription("");
    setFolderId("");
    setTtl("1");
    setProxied(true);
    setPreview(null);
    setPreviewError(null);
    setIsPreviewLoading(false);
    setNodeOptions(null);
    setNodesError(null);
    setNodesLoading(false);
    setNginxNodeId("");
  };

  const scheduleReset = () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      resetForm();
      resetTimerRef.current = null;
    }, 320);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    } else {
      scheduleReset();
    }
    onOpenChange(nextOpen);
  };

  const ttlValue = useMemo(() => {
    const value = Number(ttl);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }, [ttl]);

  useEffect(() => {
    if (!open || !resetTimerRef.current) return;
    clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  }, [open]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    void fetchFolders("domain");
    setNodesLoading(true);
    api
      .listDomainNginxNodes()
      .then((result) => {
        setNodeOptions(result);
        setNodesError(null);
        setNginxNodeId((current) => {
          if (result.eligibleNodes.some((node) => node.id === current)) return current;
          return result.eligibleNodes.length === 1 ? result.eligibleNodes[0]!.id : "";
        });
      })
      .catch((error) => {
        setNodeOptions(null);
        setNodesError(error instanceof Error ? error.message : "Unable to load Ingress nodes");
      })
      .finally(() => setNodesLoading(false));
  }, [fetchFolders, open]);

  useEffect(() => {
    if (!open) return;

    const normalizedDomain = domain.trim();
    if (
      normalizedDomain.length < 4 ||
      !normalizedDomain.includes(".") ||
      nodesLoading ||
      !nginxNodeId
    ) {
      setPreview(null);
      setPreviewError(null);
      setIsPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setIsPreviewLoading(true);
    const timer = window.setTimeout(() => {
      api
        .previewDomain({
          domain: normalizedDomain,
          dnsProvider,
          ...(dnsProvider === "cloudflare" ? { ttl: ttlValue, proxied } : {}),
          nginxNodeId,
        })
        .then((result) => {
          if (cancelled) return;
          setPreview(result);
          setPreviewError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(err instanceof Error ? err.message : "Unable to preview DNS target");
        })
        .finally(() => {
          if (!cancelled) setIsPreviewLoading(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [dnsProvider, domain, nginxNodeId, nodesLoading, open, proxied, ttlValue]);

  const create = async (overwriteDns = false) => {
    return api.createDomain({
      domain: domain.trim(),
      dnsProvider,
      description: description.trim() || undefined,
      folderId: folderId || undefined,
      ...(dnsProvider === "cloudflare" ? { ttl: ttlValue, proxied, overwriteDns } : {}),
      nginxNodeId,
    });
  };

  const handleSubmit = async () => {
    if (!domain.trim()) {
      toast.error("Domain is required");
      return;
    }
    if (!nginxNodeId) {
      toast.error("Select an ingress node with a public address");
      return;
    }
    setIsSaving(true);
    try {
      await create();
      toast.success("Domain added");
      handleOpenChange(false);
      onCreated();
    } catch (err) {
      if (
        err instanceof ApiRequestError &&
        err.code === "DOMAIN_DNS_TARGET_MISMATCH" &&
        (err.details as DomainDnsConflictDetails | undefined)?.canOverwrite
      ) {
        const details = err.details as DomainDnsConflictDetails;
        const current = details.currentRecords
          ?.map((record) => `${record.type} ${record.content}`)
          .join(", ");
        const desired = details.desiredRecords
          ?.map((record) => `${record.type} ${record.content}`)
          .join(", ");
        const ok = await confirm({
          title: "Overwrite Cloudflare DNS",
          description: `Existing DNS target differs${details.zoneName ? ` in ${details.zoneName}` : ""}. Current: ${current || "unknown"}. Desired: ${desired || "unknown"}.`,
          confirmLabel: "Overwrite DNS",
          variant: "destructive",
        });
        if (ok) {
          try {
            await create(true);
            toast.success("Domain added");
            handleOpenChange(false);
            onCreated();
          } catch (retryError) {
            toast.error(retryError instanceof Error ? retryError.message : "Failed to add domain");
          }
        }
        setIsSaving(false);
        return;
      }
      setPreviewError(err instanceof Error ? err.message : "Failed to add domain");
      toast.error(err instanceof Error ? err.message : "Failed to add domain");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Domain</DialogTitle>
          <DialogDescription>
            {dnsProvider === "cloudflare"
              ? "Register a domain to track its DNS status and manage certificates."
              : "Check existing DNS against the selected Ingress node without changing DNS records."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="border border-border bg-card">
            <SettingsControlRow
              title="Domain"
              description="Domain name to register"
              className="sm:grid-cols-[minmax(8rem,1fr)_minmax(0,12rem)]"
              controlsClassName="sm:w-full sm:min-w-0 sm:max-w-none"
            >
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com"
                autoFocus
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Description"
              description="Optional description"
              className="sm:grid-cols-[minmax(8rem,1fr)_minmax(0,12rem)]"
              controlsClassName="sm:w-full sm:min-w-0 sm:max-w-none"
            >
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description"
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Folder"
              description="Optional organization folder"
              className="sm:grid-cols-[minmax(8rem,1fr)_minmax(0,12rem)]"
              controlsClassName="sm:w-full sm:min-w-0 sm:max-w-none"
            >
              <Select
                value={folderId || "__none__"}
                onValueChange={(value) => setFolderId(value === "__none__" ? "" : value)}
                disabled={foldersLoading}
              >
                <SelectTrigger aria-label="Folder" aria-busy={foldersLoading}>
                  {foldersLoading ? (
                    <span>Loading folders...</span>
                  ) : (
                    <SelectValue placeholder="No folder" />
                  )}
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No folder</SelectItem>
                  {folderList.map((folder) => (
                    <SelectItem key={folder.id} value={folder.id}>
                      {"  ".repeat(folder.depth) + folder.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsControlRow>
            <SettingsControlRow
              title="Ingress node"
              description="Public ingress for this domain"
              className="sm:grid-cols-[minmax(8rem,1fr)_minmax(0,12rem)]"
              controlsClassName="sm:w-full sm:min-w-0 sm:max-w-none"
            >
              {nodesLoading ? (
                <span className="text-sm text-muted-foreground">Loading nodes...</span>
              ) : nodeOptions && nodeOptions.eligibleNodes.length > 0 ? (
                <Select value={nginxNodeId} onValueChange={setNginxNodeId}>
                  <SelectTrigger aria-label="Ingress node">
                    <SelectValue placeholder="Select node">
                      {selectedNginxNode?.displayName || selectedNginxNode?.hostname}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {nodeOptions.eligibleNodes.map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.displayName || node.hostname} · {node.effectiveAddress}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="text-sm text-muted-foreground">Unavailable</span>
              )}
            </SettingsControlRow>
            {dnsProvider === "cloudflare" && (
              <>
                <SettingsControlRow
                  title="TTL"
                  description="DNS record time to live"
                  className="sm:grid-cols-[minmax(8rem,1fr)_minmax(0,12rem)]"
                  controlsClassName="sm:w-full sm:min-w-0 sm:max-w-none"
                >
                  <Input
                    type="number"
                    min={1}
                    value={ttl}
                    onChange={(e) => setTtl(e.target.value)}
                    placeholder="1"
                  />
                </SettingsControlRow>
                <SettingsControlRow
                  title="Proxied"
                  description="Use Cloudflare proxy"
                  className="sm:grid-cols-[minmax(8rem,1fr)_minmax(0,12rem)]"
                  controlsClassName="sm:w-full sm:min-w-0 sm:max-w-none"
                >
                  <Switch checked={proxied} onChange={setProxied} />
                </SettingsControlRow>
              </>
            )}
          </div>
          <AnimatePresence initial={false}>
            {(preview || previewError || isPreviewLoading) && (
              <motion.div {...PREVIEW_ANIMATION} className="overflow-hidden">
                <div className="border border-border">
                  <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                    <span className="text-sm font-medium">
                      {dnsProvider === "cloudflare" ? "Cloudflare DNS preview" : "DNS check"}
                    </span>
                    {isPreviewLoading ? (
                      <LoaderCircle
                        className="h-4 w-4 animate-spin text-muted-foreground"
                        aria-label="Loading"
                      />
                    ) : preview && preview.status !== "ready" && preview.status !== "valid" ? (
                      <Badge
                        variant={
                          preview.status === "mismatch" ||
                          preview.status === "blocked" ||
                          preview.status === "invalid"
                            ? "warning"
                            : "secondary"
                        }
                        size="inline"
                      >
                        {preview.status}
                      </Badge>
                    ) : null}
                  </div>
                  {preview?.dnsProvider === "cloudflare" ? (
                    <div className="divide-y divide-border">
                      <DetailRow
                        label="Zone"
                        value={<span className="font-medium">{preview.zoneName}</span>}
                      />
                      <DetailRow
                        label="Target"
                        value={
                          <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
                            {preview.desiredRecords.map((record) => (
                              <Badge key={`${record.type}-${record.content}`} variant="outline">
                                {record.type} {record.content}
                              </Badge>
                            ))}
                          </div>
                        }
                      />
                      {preview.currentRecords.length > 0 && (
                        <DetailRow
                          label="Current"
                          value={
                            <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
                              {preview.currentRecords.map((record) => (
                                <Badge
                                  key={record.id ?? `${record.type}-${record.content}`}
                                  variant="outline"
                                >
                                  {record.type} {record.content}
                                </Badge>
                              ))}
                            </div>
                          }
                        />
                      )}
                    </div>
                  ) : preview?.dnsProvider === "external" ? (
                    <div className="divide-y divide-border">
                      <DetailRow
                        label="Expected"
                        value={
                          <span className="break-all font-mono text-xs">
                            {preview.targetIps.join(", ")}
                          </span>
                        }
                      />
                      <DetailRow
                        label="Resolved"
                        value={
                          <span className="break-all font-mono text-xs">
                            {[...preview.dnsRecords.a, ...preview.dnsRecords.aaaa].join(", ") ||
                              "No address records"}
                          </span>
                        }
                      />
                      {preview.queryName !== preview.domain && (
                        <DetailRow
                          label="Checked name"
                          value={
                            <span className="break-all font-mono text-xs">{preview.queryName}</span>
                          }
                        />
                      )}
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-sm">
                      <p className="text-muted-foreground">
                        {previewError ?? "Loading DNS preview..."}
                      </p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              isSaving ||
              nodesLoading ||
              !nginxNodeId ||
              !!nodesError ||
              (dnsProvider === "external" &&
                (isPreviewLoading ||
                  preview?.dnsProvider !== "external" ||
                  preview.status !== "valid"))
            }
          >
            {isSaving
              ? "Adding..."
              : dnsProvider === "external"
                ? "Check DNS and Add"
                : "Add Domain"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function flattenFolders(folders: ResourceFolderTreeNode[]): ResourceFolderTreeNode[] {
  return folders.flatMap((folder) => [folder, ...flattenFolders(folder.children)]);
}
