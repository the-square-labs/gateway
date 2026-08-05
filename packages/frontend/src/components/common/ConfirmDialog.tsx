import { create } from "zustand";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConfirmState {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  cancelVariant: "outline" | "ghost";
  variant: "default" | "destructive";
  locked: boolean;
  onConfirm: (() => void) | null;
  show: (opts: {
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    cancelVariant?: "outline" | "ghost";
    variant?: "default" | "destructive";
    locked?: boolean;
    onConfirm: () => void;
  }) => void;
  close: () => void;
}

export const useConfirmDialog = create<ConfirmState>()((set) => ({
  open: false,
  title: "",
  description: "",
  confirmLabel: "Confirm",
  cancelLabel: "Cancel",
  cancelVariant: "outline",
  variant: "default",
  locked: false,
  onConfirm: null,
  show: ({
    title,
    description,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    cancelVariant = "outline",
    variant = "destructive",
    locked = false,
    onConfirm,
  }) =>
    set({
      open: true,
      title,
      description,
      confirmLabel,
      cancelLabel,
      cancelVariant,
      variant,
      locked,
      onConfirm,
    }),
  close: () => set({ open: false, onConfirm: null }),
}));

export function confirm(opts: {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  cancelVariant?: "outline" | "ghost";
  variant?: "default" | "destructive";
  locked?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmDialog.getState().show({
      ...opts,
      onConfirm: () => {
        resolve(true);
        useConfirmDialog.getState().close();
      },
    });
    const unsub = useConfirmDialog.subscribe((state) => {
      if (!state.open) {
        resolve(false);
        unsub();
      }
    });
  });
}

export function ConfirmDialog() {
  const {
    open,
    title,
    description,
    confirmLabel,
    cancelLabel,
    cancelVariant,
    variant,
    locked,
    onConfirm,
    close,
  } = useConfirmDialog();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !locked && close()}>
      <DialogContent
        hideCloseButton={locked}
        className="max-w-[calc(100vw-2rem)] sm:max-w-md"
        onEscapeKeyDown={(event) => {
          if (locked) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (locked) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (locked) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="break-words [overflow-wrap:anywhere]">
          {description}
        </DialogDescription>
        <DialogFooter>
          <Button variant={cancelVariant} onClick={close}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={() => {
              onConfirm?.();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
