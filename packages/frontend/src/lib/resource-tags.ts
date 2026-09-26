import type { BadgeProps } from "@/components/ui/badge";
import { getNodeAppearanceColor } from "@/lib/node-appearance";
import type { NodeAppearanceColor } from "@/types";

/**
 * Tags on databases and storage connections. A tag written as `color:label`
 * is shown in that color; any other tag is blue.
 */
export const RESOURCE_TAG_COLORS = [
  "blue",
  "red",
  "green",
  "yellow",
  "purple",
  "pink",
  "orange",
  "gray",
] as const;

export type ResourceTagColor = (typeof RESOURCE_TAG_COLORS)[number];

export interface ParsedResourceTag {
  raw: string;
  label: string;
  color: ResourceTagColor;
}

export function parseResourceTag(raw: string): ParsedResourceTag {
  const trimmed = raw.trim();
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    const color = trimmed.slice(0, colonIndex).toLowerCase();
    const label = trimmed.slice(colonIndex + 1).trim();
    if ((RESOURCE_TAG_COLORS as readonly string[]).includes(color) && label) {
      return { raw, label, color: color as ResourceTagColor };
    }
  }
  return { raw, label: trimmed, color: "blue" };
}

const TAG_BADGE_VARIANTS: Partial<Record<ResourceTagColor, NonNullable<BadgeProps["variant"]>>> = {
  blue: "info",
  red: "destructive",
  green: "success",
  yellow: "warning",
  gray: "secondary",
};

/**
 * Badge props for a tag: the matching Badge variant, or the shared node
 * appearance palette for colors that have no variant.
 */
export function resourceTagBadgeProps(
  color: ResourceTagColor
): Pick<BadgeProps, "variant" | "className"> {
  const variant = TAG_BADGE_VARIANTS[color];
  if (variant) return { variant };
  return {
    variant: "secondary",
    className: getNodeAppearanceColor(color as NodeAppearanceColor)?.badgeClassName,
  };
}

export function estimateResourceTagWidth(tag: ParsedResourceTag): number {
  return Math.min(180, Math.max(44, tag.label.length * 7 + 24));
}

export function estimateMoreTagsWidth(count: number): number {
  return 44 + String(count).length * 7;
}
