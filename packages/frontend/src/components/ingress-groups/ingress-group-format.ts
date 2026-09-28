import type { BadgeProps } from "@/components/ui/badge";
import type {
  IngressGroup,
  IngressGroupMember,
  IngressGroupMemberState,
  IngressMemberDeliveryStatus,
} from "@/types";

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

export const MEMBER_STATE_BADGE: Record<
  IngressGroupMemberState,
  { label: string; variant: BadgeVariant; help: string }
> = {
  joining: {
    label: "Joining",
    variant: "warning",
    help: "Receiving the routes, certificates and Secure Link sources of the group; not in DNS yet.",
  },
  active: {
    label: "Active",
    variant: "success",
    help: "Serves every route and is published in DNS.",
  },
  draining: {
    label: "Draining",
    variant: "secondary",
    help: "Withdrawn from DNS; keeps serving until no public name resolves to it (at most 24 hours).",
  },
};

export const DELIVERY_BADGE: Record<
  IngressMemberDeliveryStatus,
  { label: string; variant: BadgeVariant }
> = {
  ready: { label: "Applied", variant: "success" },
  pending: { label: "Pending", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
  disabled: { label: "Disabled", variant: "secondary" },
};

export function memberName(member: Pick<IngressGroupMember, "nodeId" | "node">): string {
  return member.node?.displayName || member.node?.hostname || member.nodeId;
}

/** One line on what a member's ingress health endpoint answers. */
export function memberHealthLabel(member: IngressGroupMember): {
  label: string;
  variant: BadgeVariant;
  detail: string | null;
} {
  if (!member.node?.connected) {
    return {
      label: "Offline",
      variant: "destructive",
      detail: "The nginx daemon is not connected",
    };
  }
  if (!member.health) {
    return {
      label: "No report",
      variant: "secondary",
      detail: "The daemon has not reported ingress health yet",
    };
  }
  if (member.health.serving) return { label: "Serving", variant: "success", detail: null };
  return { label: "Not serving", variant: "destructive", detail: member.health.reason || null };
}

/** The group badge on lists and the detail header. */
export function groupHealthBadge(group: IngressGroup): { label: string; variant: BadgeVariant } {
  if (group.members.length === 0) return { label: "No members", variant: "destructive" };
  if (group.healthy) return { label: "Healthy", variant: "success" };
  const active = group.members.filter((member) => member.state === "active");
  const serving = active.filter(
    (member) => member.node?.connected && member.health?.serving !== false
  );
  if (serving.length === 0) return { label: "Down", variant: "destructive" };
  return { label: "Degraded", variant: "warning" };
}

/** A short hash for a delivered config (full hash in the tooltip). */
export function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 8) : "—";
}
