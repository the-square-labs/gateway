import { ArrowRight, Bot, LayoutDashboard, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Choice = { label: string; description: string; icon: LucideIcon; onSelect: () => void };
type InterfaceChoiceDialogProps = {
  open: boolean;
  busy: boolean;
  onOpenChange?: (open: boolean) => void;
} & (
  | {
      choices: Choice[];
      title: string;
      description: string;
      onAIWorkspace?: never;
      onOperationsConsole?: never;
    }
  | {
      choices?: never;
      title?: never;
      description?: never;
      onAIWorkspace: () => void;
      onOperationsConsole: () => void;
    }
);

export function InterfaceChoiceDialog(props: InterfaceChoiceDialogProps) {
  const { open, busy, onOpenChange } = props;
  const choices: Choice[] = props.choices ?? [
    {
      label: "AI Workspace",
      icon: Bot,
      onSelect: props.onAIWorkspace!,
      description:
        "Start from an outcome, keep guidance and infrastructure context in one Work Session, and move into Gateway resources without losing the conversation.",
    },
    {
      label: "Operations Console",
      icon: LayoutDashboard,
      onSelect: props.onOperationsConsole!,
      description:
        "Use the complete Gateway interface directly. Every capability remains available without AI, and AI Workspace stays one click away when configured.",
    },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange ?? (() => {})} modal>
      <DialogContent
        hideCloseButton={!onOpenChange}
        className="sm:max-w-xl"
        onEscapeKeyDown={onOpenChange ? undefined : (event) => event.preventDefault()}
        onPointerDownOutside={onOpenChange ? undefined : (event) => event.preventDefault()}
        onInteractOutside={onOpenChange ? undefined : (event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{props.title ?? "Choose your Gateway interface"}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {props.description ??
            "AI Workspace is the recommended intent-driven interface for understanding and operating Gateway. Operations Console remains a complete interface and does not depend on AI."}
        </DialogDescription>
        <div className="grid gap-3">
          {choices.map(({ label, description, icon: Icon, onSelect }) => (
            <Button
              key={label}
              type="button"
              variant="outline"
              className="h-auto w-full justify-start whitespace-normal px-4 py-3 text-left"
              disabled={busy}
              onClick={onSelect}
            >
              <span className="flex w-full items-center gap-3">
                <Icon className="!h-5 !w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium text-foreground">{label}</span>
                  <span className="mt-0.5 block text-[13px] font-normal text-muted-foreground">
                    {description}
                  </span>
                </span>
                <ArrowRight className="shrink-0 text-muted-foreground" />
              </span>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
