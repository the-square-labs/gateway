import { useId } from "react";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { PageProject, PageTag } from "@/types";
import { UpstreamField, type UpstreamFieldLayout } from "./upstream-field";

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
  selectedProjectLabel?: string;
  selectedTagLabel?: string;
  availability?: {
    label: string;
    variant: BadgeProps["variant"];
  };
  availabilityDescription?: string;
  /** Settings rows (default) or stacked form fields for form dialogs. */
  layout?: UpstreamFieldLayout;
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
  selectedProjectLabel,
  selectedTagLabel,
  availability,
  availabilityDescription,
  layout = "rows",
}: PagesTargetPickerProps) {
  const fieldId = useId();
  const showProjectFallback =
    Boolean(projectId) && !projects.some((project) => project.id === projectId);
  const showTagFallback = Boolean(tagId) && !tags.some((tag) => tag.id === tagId);
  const projectOptions: ComboboxOption[] = [
    ...projects.map((project) => ({
      value: project.id,
      label: `${project.name} · ${project.slug}`,
      keywords: `${project.name} ${project.slug}`,
    })),
    ...(showProjectFallback
      ? [
          {
            value: projectId,
            label: selectedProjectLabel ?? "Selected Project",
          },
        ]
      : []),
  ];
  const tagOptions: ComboboxOption[] = [
    ...tags.map((tag) => ({
      value: tag.id,
      label: `${tag.name}${tag.system ? " · system" : ""}${
        tag.deployment ? ` · ${tag.deployment.publicSlug}` : " · no Deployment"
      }`,
      keywords: [tag.name, tag.deployment?.publicSlug, tag.system ? "system" : null]
        .filter(Boolean)
        .join(" "),
    })),
    ...(showTagFallback
      ? [
          {
            value: tagId,
            label: selectedTagLabel ?? "Selected Tag",
          },
        ]
      : []),
  ];

  return (
    <>
      <UpstreamField
        layout={layout}
        id={`${fieldId}-project`}
        title="Page Project"
        description="Project that owns the Tag served by this route."
      >
        <Combobox
          id={`${fieldId}-project`}
          value={projectId}
          options={projectOptions}
          onValueChange={onProjectChange}
          placeholder={projectsLoading ? "Loading Projects…" : "Select a Project"}
          searchPlaceholder="Search projects..."
          emptyMessage="No matching Page Projects."
          ariaLabel="Page Project"
          disabled={projectsLoading || disabled}
        />
      </UpstreamField>
      <UpstreamField
        layout={layout}
        id={`${fieldId}-tag`}
        title="Tag"
        description="Mutable Tag whose ready Deployment is published on this route."
      >
        <Combobox
          id={`${fieldId}-tag`}
          value={tagId}
          options={tagOptions}
          onValueChange={onTagChange}
          placeholder={tagsLoading ? "Loading Tags…" : "Select a Tag"}
          searchPlaceholder="Search tags..."
          emptyMessage="No matching Tags."
          ariaLabel="Tag"
          disabled={!projectId || tagsLoading || disabled}
        />
      </UpstreamField>
      {availability ? (
        <UpstreamField layout={layout} title="Availability" description={availabilityDescription}>
          <div>
            <Badge variant={availability.variant}>{availability.label}</Badge>
          </div>
        </UpstreamField>
      ) : null}
    </>
  );
}
