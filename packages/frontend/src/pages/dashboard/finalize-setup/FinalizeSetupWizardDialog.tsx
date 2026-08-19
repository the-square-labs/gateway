import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const STEP_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

export function FinalizeSetupWizardDialog({
  open,
  title,
  description,
  stepKey,
  children,
  footer,
  footerLeft,
  onClose,
  onBack,
  backDisabled = false,
  onSkip,
  skipDisabled = false,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  stepKey: string;
  children: ReactNode;
  footer?: ReactNode;
  footerLeft?: ReactNode;
  /** Optional explicit exit for standalone setup flows. */
  onClose?: () => void;
  onBack?: () => void;
  backDisabled?: boolean;
  onSkip?: () => void | Promise<void>;
  skipDisabled?: boolean;
}) {
  const [skipping, setSkipping] = useState(false);
  const hasFooter = Boolean(footerLeft || footer || onBack || onSkip);

  useEffect(() => {
    if (!open) {
      setSkipping(false);
    }
  }, [open]);

  const skip = async () => {
    if (!onSkip) return;
    setSkipping(true);
    try {
      await onSkip();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to skip this setup step");
    } finally {
      setSkipping(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose?.();
      }}
      modal
    >
      <DialogContent
        hideCloseButton={!onClose}
        className="sm:max-w-xl"
        style={{ overflow: "hidden" }}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          if (!onClose) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (!onClose) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogDescription asChild>
          <div className="space-y-2">{description}</div>
        </DialogDescription>
        <AnimatedHeight>
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div key={stepKey} {...STEP_ANIMATION}>
              {children}
            </motion.div>
          </AnimatePresence>
        </AnimatedHeight>
        {hasFooter && (
          <DialogFooter
            data-setup-footer=""
            className={footerLeft ? "sm:justify-between" : undefined}
          >
            {footerLeft && <div className="mr-auto flex items-center">{footerLeft}</div>}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:space-x-2 sm:gap-0">
              {onBack && (
                <Button variant="outline" onClick={onBack} disabled={backDisabled}>
                  <ArrowLeft />
                  Back
                </Button>
              )}
              {onSkip && (
                <Button
                  variant="outline"
                  onClick={() => void skip()}
                  disabled={skipDisabled || skipping}
                >
                  <MoreHorizontal />
                  Skip
                </Button>
              )}
              {footer}
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
