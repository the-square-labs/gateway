import { ArrowRight, Bot, LayoutDashboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function InterfaceChoiceDialog({
  open,
  busy,
  onAIWorkspace,
  onOperationsConsole,
}: {
  open: boolean;
  busy: boolean;
  onAIWorkspace: () => void;
  onOperationsConsole: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={() => {}} modal>
      <DialogContent
        hideCloseButton
        className="sm:max-w-xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Choose your Gateway interface</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          AI Workspace is the recommended intent-driven interface for understanding and operating
          Gateway. Operations Console remains a complete interface and does not depend on AI.
        </DialogDescription>
        <div className="grid gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-auto w-full justify-start whitespace-normal px-4 py-3 text-left"
            disabled={busy}
            onClick={onAIWorkspace}
          >
            <span className="flex w-full items-center gap-3">
              <Bot className="!h-5 !w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium text-foreground">AI Workspace</span>
                <span className="mt-0.5 block text-[13px] font-normal text-muted-foreground">
                  Start from an outcome, keep guidance and infrastructure context in one Work
                  Session, and move into Gateway resources without losing the conversation.
                </span>
              </span>
              <ArrowRight className="shrink-0 text-muted-foreground" />
            </span>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto w-full justify-start whitespace-normal px-4 py-3 text-left"
            disabled={busy}
            onClick={onOperationsConsole}
          >
            <span className="flex w-full items-center gap-3">
              <LayoutDashboard className="!h-5 !w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium text-foreground">
                  Operations Console
                </span>
                <span className="mt-0.5 block text-[13px] font-normal text-muted-foreground">
                  Use the complete Gateway interface directly. Every capability remains available
                  without AI, and AI Workspace stays one click away when configured.
                </span>
              </span>
              <ArrowRight className="shrink-0 text-muted-foreground" />
            </span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
