import { ArrowRight, Bot, Check, Cloud, Cpu, KeyRound, Server, Sparkles, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FinalizeSetupState, FinalizeSetupStep, FinalizeSetupStepStatus } from "@/types";

export type FinalizeSetupRootStep =
  | Exclude<FinalizeSetupStep, "cloudflare" | "gitlab">
  | "integrations";

const ROOT_STEPS: Array<{
  id: FinalizeSetupRootStep;
  title: string;
  description: string;
  icon: typeof Server;
}> = [
  {
    id: "nodes",
    title: "Connect your first node",
    description: "Enroll an nginx, Docker, database, or monitoring node.",
    icon: Server,
  },
  {
    id: "ai_assistant",
    title: "Configure AI Assistant",
    description: "Give Gateway an AI provider for assistance and automation.",
    icon: Bot,
  },
  {
    id: "inference",
    title: "Configure Gateway Inference",
    description: "Connect a provider and make models available through Gateway.",
    icon: Cpu,
  },
  {
    id: "mfa",
    title: "Set up MFA for your account",
    description: "Protect this administrator account with a passkey or authenticator app.",
    icon: KeyRound,
  },
  {
    id: "invite_users",
    title: "Invite users",
    description: "Create an additional local account and send its sign-in instructions.",
    icon: UserPlus,
  },
  {
    id: "integrations",
    title: "Connect integrations",
    description: "Configure Cloudflare and GitLab for infrastructure workflows.",
    icon: Cloud,
  },
];

function stepStatus(
  state: FinalizeSetupState,
  step: FinalizeSetupRootStep
): FinalizeSetupStepStatus {
  if (step !== "integrations") return state.steps[step];
  const statuses = [state.steps.cloudflare, state.steps.gitlab];
  if (statuses.some((status) => status === "configured")) return "configured";
  if (statuses.every((status) => status !== "pending")) return "skipped";
  return "pending";
}

function StatusBadge({ status }: { status: FinalizeSetupStepStatus }) {
  if (status === "configured") {
    return (
      <Badge variant="success" className="gap-1">
        <Check className="h-3 w-3" /> Configured
      </Badge>
    );
  }
  if (status === "skipped") return <Badge variant="outline">Skipped</Badge>;
  return <Badge variant="secondary">Not started</Badge>;
}

export function FinalizeSetupDialog({
  open,
  state,
  busy,
  canInviteUsers = false,
  onOpenWizard,
  onDismiss,
}: {
  open: boolean;
  state: FinalizeSetupState;
  busy?: boolean;
  canInviteUsers?: boolean;
  onOpenWizard: (step: FinalizeSetupRootStep) => void;
  onDismiss: () => void | Promise<void>;
}) {
  const hasConfiguredStep = Object.values(state.steps).some((status) => status === "configured");
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    if (!open) {
      setDismissing(false);
    }
  }, [open]);

  const dismiss = async () => {
    setDismissing(true);
    try {
      await onDismiss();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to finalize setup");
    } finally {
      setDismissing(false);
    }
  };

  const requestDismiss = async () => {
    const confirmed = await confirm({
      title: "Skip the guided setup?",
      description:
        "These steps introduce Gateway's core capabilities. If you are new to Gateway or want to understand its features in more detail, we recommend completing at least the items that apply to your installation. You can still configure every feature later from Settings.",
      cancelLabel: "Continue setup",
      confirmLabel: "Skip checklist",
      variant: "default",
      locked: true,
    });
    if (confirmed) await dismiss();
  };

  return (
    <Dialog open={open} onOpenChange={() => {}} modal>
      <DialogContent
        hideCloseButton
        className="sm:max-w-2xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Finalize Gateway setup</DialogTitle>
        </DialogHeader>
        <DialogDescription asChild>
          <div className="space-y-2">
            <p>
              Gateway is ready to use. This checklist walks the first administrator through the
              capabilities that usually make a new installation useful: infrastructure nodes,
              account protection, optional AI, and external integrations.
            </p>
            <p>
              Every item stays inside this guided experience and only applies changes after you
              explicitly save them. Complete the parts that apply to this installation; a completed
              item is marked here so you can see your progress.
            </p>
            <p>
              You can skip the checklist or an optional flow and return to every setting later. If
              Gateway is new to you, completing at least the relevant items provides the quickest
              path to understanding how its core features fit together.
            </p>
          </div>
        </DialogDescription>
        <div className="space-y-3">
          {ROOT_STEPS.filter((step) => step.id !== "invite_users" || canInviteUsers).map((step) => {
            const Icon = step.icon;
            const status = stepStatus(state, step.id);
            const canOpen = status !== "configured";
            return (
              <Button
                key={step.id}
                type="button"
                variant="outline"
                className="h-auto w-full justify-start whitespace-normal px-4 py-3 text-left"
                disabled={!canOpen || busy}
                onClick={() => onOpenWizard(step.id)}
              >
                <span className="flex w-full items-center gap-3">
                  <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-medium text-foreground">
                      {step.title}
                    </span>
                    <span className="mt-0.5 block text-[13px] font-normal text-muted-foreground">
                      {step.description}
                    </span>
                  </span>
                  <span className="shrink-0">
                    <StatusBadge status={status} />
                  </span>
                </span>
              </Button>
            );
          })}
        </div>
        <DialogFooter>
          <Button
            variant={hasConfiguredStep ? "default" : "outline"}
            onClick={() => void (hasConfiguredStep ? dismiss() : requestDismiss())}
            disabled={busy || dismissing}
          >
            {hasConfiguredStep ? (
              <>
                <Sparkles />
                Finish
              </>
            ) : (
              <>
                Skip
                <ArrowRight />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
