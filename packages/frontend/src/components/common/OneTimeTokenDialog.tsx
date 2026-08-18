import { CopyValueField } from "@/components/common/CopyValueField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function OneTimeTokenDialog({
  open,
  onOpenChange,
  title,
  token,
  tokenLabel,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  token: string | null;
  tokenLabel: string;
  onClosed: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onAnimationEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.currentTarget.dataset.state === "closed"
          ) {
            onClosed();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Copy the token before closing this dialog.</DialogDescription>
        </DialogHeader>

        {token && (
          <div className="space-y-4">
            <div className="border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
              <p className="font-medium">Copy this token now. It will not be shown again.</p>
            </div>
            <CopyValueField
              label={tokenLabel}
              value={token}
              className="[&>p]:hidden"
              valueClassName="font-mono"
            />
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
