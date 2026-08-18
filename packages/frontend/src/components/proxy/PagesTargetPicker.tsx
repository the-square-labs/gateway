import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PageProject, PageTag } from "@/types";

export interface PagesTargetPickerProps {
  projectId: string;
  tagId: string;
  onProjectChange: (projectId: string) => void;
  onTagChange: (tagId: string) => void;
  projects: PageProject[];
  tags: PageTag[];
  projectsLoading?: boolean;
  tagsLoading?: boolean;
  disabled?: boolean;
  availability?: {
    label: string;
    variant: BadgeProps["variant"];
  };
  availabilityDescription?: string;
}

/**
 * Shared Pages target controls for host and path-route wizards.
 *
 * Projects contain mutable Tags; deployments are deliberately only displayed
 * as readiness context and are never selectable as a route target.
 */
export function PagesTargetPicker({
  projectId,
  tagId,
  onProjectChange,
  onTagChange,
  projects,
  tags,
  projectsLoading = false,
  tagsLoading = false,
  disabled = false,
  availability,
  availabilityDescription,
}: PagesTargetPickerProps) {
  return (
    <>
      <SettingsControlRow
        title="Page Project"
        description="Project that owns the Tag served by this route."
      >
        <Select
          value={projectId || "__none__"}
          onValueChange={(value) => onProjectChange(value === "__none__" ? "" : value)}
          disabled={projectsLoading || disabled}
        >
          <SelectTrigger aria-label="Page Project">
            <SelectValue placeholder={projectsLoading ? "Loading Projects…" : "Select a Project"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__" disabled>
              Select a Project
            </SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name} · {project.slug}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsControlRow>
      <SettingsControlRow
        title="Tag"
        description="Mutable Tag whose ready Deployment is published on this route."
      >
        <Select
          value={tagId || "__none__"}
          onValueChange={(value) => onTagChange(value === "__none__" ? "" : value)}
          disabled={!projectId || tagsLoading || disabled}
        >
          <SelectTrigger aria-label="Tag">
            <SelectValue placeholder={tagsLoading ? "Loading Tags…" : "Select a Tag"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__" disabled>
              Select a Tag
            </SelectItem>
            {tags.map((tag) => (
              <SelectItem key={tag.id} value={tag.id}>
                {tag.name}
                {tag.system ? " · system" : ""}
                {tag.deployment ? ` · ${tag.deployment.publicSlug}` : " · no Deployment"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsControlRow>
      {availability ? (
        <SettingsControlRow title="Availability" description={availabilityDescription}>
          <Badge variant={availability.variant}>{availability.label}</Badge>
        </SettingsControlRow>
      ) : null}
    </>
  );
}
