import { useEffect } from "react";
import { useContentLoading } from "@/components/common/reveal-gate";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type CreationFolderChoices,
  creationFolderChoices,
  flattenCreationFolders,
} from "@/lib/creation-folders";
import type { ResourceFolderTreeNode } from "@/types";

/** Select value of the root destination ("No folder"). The form state keeps "" for the root. */
const ROOT_VALUE = "__none__";

/**
 * Destinations offered by a create dialog: allowed root, allowed folders in tree order, and the
 * initial selection (root when allowed, else the only allowed folder, else none).
 */
export type CreateFolderChoices = CreationFolderChoices;

/**
 * Destinations for a resource folder tree, with the same rule the backend applies
 * (`hasScopeForCreation`): a broad or node grant allows every folder and the root,
 * a folder grant allows only that folder (and its subfolders, expanded by the server).
 */
export function getCreateFolderChoices(
  scopes: readonly string[],
  createScope: string,
  folders: ResourceFolderTreeNode[],
  nodeId?: string
): CreateFolderChoices {
  return creationFolderChoices(scopes, createScope, flattenCreationFolders(folders), nodeId);
}

/** Whether the selected destination ("" = root) is one the caller may create in. */
export function isCreateFolderAllowed(choices: CreateFolderChoices, folderId: string): boolean {
  return folderId ? choices.folders.some((folder) => folder.id === folderId) : choices.allowRoot;
}

export function CreateFolderSelect({
  choices,
  value,
  onChange,
  loading = false,
  disabled = false,
  id,
  ariaLabel = "Folder",
}: {
  choices: CreateFolderChoices;
  /** Selected folder id; "" is the root. */
  value: string;
  onChange: (folderId: string) => void;
  loading?: boolean;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
}) {
  // The folder list decides the destinations offered: the dialog waits for it.
  useContentLoading(loading);
  const allowed = isCreateFolderAllowed(choices, value);
  // Keep the selection valid when the folder tree or the grants change (for example
  // after picking another node): fall back to the root or the only allowed folder.
  useEffect(() => {
    if (loading || allowed || value === choices.defaultFolderId) return;
    onChange(choices.defaultFolderId);
  }, [allowed, choices.defaultFolderId, loading, onChange, value]);

  return (
    <Select
      value={value ? value : choices.allowRoot ? ROOT_VALUE : ""}
      onValueChange={(next) => onChange(next === ROOT_VALUE ? "" : next)}
      disabled={disabled || loading}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} aria-busy={loading}>
        <SelectValue
          placeholder={
            loading
              ? "Loading folders…"
              : choices.allowRoot || choices.folders.length > 0
                ? "Select a folder"
                : "No folder you can create in"
          }
        />
      </SelectTrigger>
      <SelectContent>
        {choices.allowRoot && <SelectItem value={ROOT_VALUE}>No folder</SelectItem>}
        {choices.folders.map((folder) => (
          <SelectItem key={folder.id} value={folder.id}>
            {"  ".repeat(folder.depth) + folder.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
