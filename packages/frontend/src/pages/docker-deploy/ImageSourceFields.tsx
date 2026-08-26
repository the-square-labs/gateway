import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { Badge } from "@/components/ui/badge";
import type { DockerRegistry } from "@/types";

interface ImageSourceFieldsProps {
  availableRegistries: DockerRegistry[];
  deployImage: string;
  deployLocalImages: string[];
  deployNodeId: string;
  deployRegistryId: string;
  imageOptions: ComboboxOption[];
  registryOptions: ComboboxOption[];
  onImageChange: (value: string) => void;
  onRegistryChange: (value: string) => void;
}

export function ImageSourceFields({
  availableRegistries,
  deployImage,
  deployLocalImages,
  deployNodeId,
  deployRegistryId,
  imageOptions,
  registryOptions,
  onImageChange,
  onRegistryChange,
}: ImageSourceFieldsProps) {
  return (
    <>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Registry</label>
        <Combobox
          value={deployRegistryId || "__default__"}
          options={registryOptions}
          onValueChange={(value) => onRegistryChange(value === "__default__" ? "" : value)}
          placeholder={!deployNodeId ? "Select a node first" : "Docker Hub"}
          searchPlaceholder="Search registries..."
          emptyMessage="No registries found."
          disabled={!deployNodeId}
          renderOption={(option) => {
            const registry = availableRegistries.find((candidate) => candidate.id === option.value);
            if (!registry) return option.label;
            return (
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{registry.name}</span>
                <span className="text-muted-foreground">{registry.url}</span>
                {registry.scope === "node" && (
                  <Badge variant="secondary" size="inline">
                    This node
                  </Badge>
                )}
              </span>
            );
          }}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          Image <span className="text-destructive">*</span>
        </label>
        <Combobox
          freeText
          value={deployImage}
          options={imageOptions}
          onValueChange={onImageChange}
          placeholder={!deployNodeId ? "Select a node first" : "Select or enter an image"}
          searchPlaceholder="Search or enter an image..."
          disabled={!deployNodeId}
          renderOption={(option) => (
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate">{option.label}</span>
              <Badge variant="secondary" size="inline">
                {deployLocalImages.includes(option.value) ? "On this node" : "Pull"}
              </Badge>
            </span>
          )}
        />
        {deployImage && !deployLocalImages.includes(deployImage) && deployNodeId && (
          <p className="text-xs text-muted-foreground">Will be pulled to this node on deploy</p>
        )}
      </div>
    </>
  );
}
