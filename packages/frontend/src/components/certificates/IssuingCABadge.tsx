import type { SyntheticEvent } from "react";
import { Link } from "react-router-dom";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import type { CA, Certificate } from "@/types";

/** Keeps the link inside a clickable, draggable row from opening or dragging the row. */
const stopRowEvent = (event: SyntheticEvent) => event.stopPropagation();

interface IssuingCABadgeProps {
  certificate: Pick<Certificate, "caId" | "issuerDn">;
  /** The issuing CA when the CA list has it; otherwise the issuer DN shows as plain text. */
  ca?: CA;
  size?: BadgeProps["size"];
  className?: string;
}

/** The CA that issued a certificate, linked to the CA page when the user can view it. */
export function IssuingCABadge({ certificate, ca, size, className }: IssuingCABadgeProps) {
  const canView = useAuthStore((state) => state.hasScope(`pki:ca:view:${certificate.caId}`));
  if (!ca) {
    return (
      <span className={cn("min-w-0 truncate text-sm text-muted-foreground", className)}>
        {certificate.issuerDn || certificate.caId}
      </span>
    );
  }
  const badge = (
    <Badge variant="info" size={size}>
      {ca.commonName}
    </Badge>
  );
  if (!canView) return badge;
  return (
    <Link
      to={`/cas/${ca.id}`}
      title={ca.commonName}
      className={cn("flex min-w-0 max-w-full", className)}
      onClick={stopRowEvent}
      onPointerDown={stopRowEvent}
    >
      {badge}
    </Link>
  );
}
