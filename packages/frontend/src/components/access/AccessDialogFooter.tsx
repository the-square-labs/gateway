import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";

/**
 * The footer of every dialog with an access list: "Review N scopes" on the left opens the scope
 * picker with the raw scopes the lines stand for; Cancel and the primary action on the right.
 * DialogContent places it in its footer slot, outside the body.
 */
export function AccessDialogFooter({
  scopeCount,
  onReviewScopes,
  children,
}: {
  scopeCount: number;
  onReviewScopes: () => void;
  children: ReactNode;
}) {
  return (
    <DialogFooter>
      <Button type="button" variant="link" className="mr-auto h-auto p-0" onClick={onReviewScopes}>
        Review {scopeCount} scope{scopeCount === 1 ? "" : "s"}
      </Button>
      {children}
    </DialogFooter>
  );
}
// DialogContent finds its slots by display name.
AccessDialogFooter.displayName = "DialogFooter";
