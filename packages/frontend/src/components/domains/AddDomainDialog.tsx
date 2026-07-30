import { AnimatePresence, motion } from "framer-motion";
import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
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
import type { ResourceFolderTreeNode } from "@/types";
import type { DomainDnsConflictDetails, DomainPreview } from "@/types/domains";

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
}

export function AddDomainDialog({ open, onOpenChange, onCreated }: AddDomainDialogProps) {
  const [domain, setDomain] = useState("");
  const [description, setDescription] = useState("");
  const [folderId, setFolderId] = useState("");
  const [folderList, setFolderList] = useState<ResourceFolderTreeNode[]>([]);
  const [ttl, setTtl] = useState("1");
  const [proxied, setProxied] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [preview, setPreview] = useState<DomainPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetForm = () => {
    setDomain("");
    setDescription("");
    setFolderId("");
    setTtl("1");
    setProxied(true);
    setPreview(null);
    setPreviewError(null);
    setIsPreviewLoading(false);
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
    api
      .listDomainFolders()
      .then((folders) => setFolderList(flattenFolders(folders)))
      .catch(() => setFolderList([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const normalizedDomain = domain.trim();
    if (normalizedDomain.length < 4 || !normalizedDomain.includes(".")) {
      setPreview(null);
      setPreviewError(null);
      setIsPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setIsPreviewLoading(true);
    const timer = window.setTimeout(() => {
      api
        .previewDomain({ domain: normalizedDomain, ttl: ttlValue, proxied })
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
  }, [domain, open, proxied, ttlValue]);

  const create = async (overwriteDns = false) => {
    return api.createDomain({
      domain: domain.trim(),
      description: description.trim() || undefined,
      folderId: folderId || undefined,
      ttl: ttlValue,
      proxied,
      overwriteDns,
    });
  };

  const handleSubmit = async () => {
    if (!domain.trim()) {
      toast.error("Domain is required");
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
            Register a domain to track its DNS status and manage certificates.
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
            {folderList.length > 0 && (
              <SettingsControlRow
                title="Folder"
                description="Optional organization folder"
                className="sm:grid-cols-[minmax(8rem,1fr)_minmax(0,12rem)]"
                controlsClassName="sm:w-full sm:min-w-0 sm:max-w-none"
              >
                <Select
                  value={folderId || "__none__"}
                  onValueChange={(value) => setFolderId(value === "__none__" ? "" : value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No folder" />
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
            )}
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
          </div>
          <AnimatePresence initial={false}>
            {(preview || previewError || isPreviewLoading) && (
              <motion.div {...PREVIEW_ANIMATION} className="overflow-hidden">
                <div className="border border-border">
                  <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                    <span className="text-sm font-medium">Cloudflare DNS preview</span>
                    {isPreviewLoading ? (
                      <LoaderCircle
                        className="h-4 w-4 animate-spin text-muted-foreground"
                        aria-label="Loading"
                      />
                    ) : preview && preview.status !== "ready" ? (
                      <Badge
                        variant={
                          preview.status === "mismatch" || preview.status === "blocked"
                            ? "warning"
                            : "secondary"
                        }
                        size="inline"
                      >
                        {preview.status}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="space-y-2 px-3 py-2 text-sm">
                    {preview ? (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-muted-foreground">Zone</span>
                          <span className="font-medium">{preview.zoneName}</span>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-muted-foreground">Target</span>
                          <div className="flex flex-wrap justify-end gap-1">
                            {preview.desiredRecords.map((record) => (
                              <Badge key={`${record.type}-${record.content}`} variant="outline">
                                {record.type} {record.content}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        {preview.currentRecords.length > 0 && (
                          <div className="flex items-start justify-between gap-3">
                            <span className="text-muted-foreground">Current</span>
                            <div className="flex flex-wrap justify-end gap-1">
                              {preview.currentRecords.map((record) => (
                                <Badge
                                  key={record.id ?? `${record.type}-${record.content}`}
                                  variant="outline"
                                >
                                  {record.type} {record.content}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-muted-foreground">
                        {previewError ?? "Loading DNS preview..."}
                      </p>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isSaving ? "Adding..." : "Add Domain"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function flattenFolders(folders: ResourceFolderTreeNode[]): ResourceFolderTreeNode[] {
  return folders.flatMap((folder) => [folder, ...flattenFolders(folder.children)]);
}
