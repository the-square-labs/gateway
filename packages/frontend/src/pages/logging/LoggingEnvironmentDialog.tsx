import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { handleLicenseApiError } from "@/stores/license-paywall";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { LoggingEnvironment, ResourceFolderTreeNode } from "@/types";

export function LoggingEnvironmentDialog({
  open,
  environment,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  environment?: LoggingEnvironment | null;
  onOpenChange: (open: boolean) => void;
  onSave: (data: Partial<LoggingEnvironment>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [folderId, setFolderId] = useState("");
  const [saving, setSaving] = useState(false);
  const folders = useResourceFolderStore((state) => state.foldersByType["logging-environment"]);
  const foldersLoading = useResourceFolderStore(
    (state) => state.loadingByType["logging-environment"]
  );
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const folderOptions = useMemo(() => flattenFolders(folders), [folders]);

  useEffect(() => {
    if (!open) return;
    setName(environment?.name ?? "");
    setDescription(environment?.description ?? "");
    setFolderId(environment?.folderId ?? "");
    if (!environment) void fetchFolders("logging-environment");
  }, [environment, fetchFolders, open]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        name,
        description: description || null,
        ...(!environment ? { folderId: folderId || null } : {}),
        schemaMode: environment?.schemaMode ?? "loose",
        retentionDays: environment?.retentionDays ?? 30,
        fieldSchema: environment?.fieldSchema ?? [],
      });
      onOpenChange(false);
    } catch (error) {
      if (!handleLicenseApiError(error, "Logging environments")) {
        toast.error(
          error instanceof Error ? error.message : "Failed to create logging environment"
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{environment ? "Edit Environment" : "Create Environment"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production"
            />
          </label>
          {!environment && (
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Folder</span>
              <Select
                value={folderId || "__none__"}
                onValueChange={(value) => setFolderId(value === "__none__" ? "" : value)}
                disabled={foldersLoading}
              >
                <SelectTrigger aria-label="Folder" aria-busy={foldersLoading}>
                  <SelectValue placeholder={foldersLoading ? "Loading folders…" : "No folder"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No folder</SelectItem>
                  {folderOptions.map((folder) => (
                    <SelectItem key={folder.id} value={folder.id}>
                      {"  ".repeat(folder.depth) + folder.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
          {environment && (
            <p className="text-xs text-muted-foreground">
              Slug: <span className="font-mono">{environment.slug}</span>
            </p>
          )}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Description</span>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Application logs from production services"
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || saving} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function flattenFolders(folders: ResourceFolderTreeNode[]): ResourceFolderTreeNode[] {
  return folders.flatMap((folder) => [folder, ...flattenFolders(folder.children)]);
}
