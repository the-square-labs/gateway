import { CircleAlert, Lock, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AIConversationSummary } from "@/services/ai-conversations";
import { AIProgressRing } from "./AIProgressRing";

function getConversationStatusIcon(conversation: AIConversationSummary) {
  switch (conversation.activeRunStatus) {
    case "waiting_for_approval":
    case "waiting_for_answer":
    case "waiting_for_credential":
    case "waiting_for_setup":
      return CircleAlert;
    default:
      if (conversation.planStatus === "awaiting_decision" || conversation.planStatus === "paused") {
        return CircleAlert;
      }
      return conversation.status === "active" ? MessageSquare : Lock;
  }
}

export function isConversationProgressActive(conversation: AIConversationSummary) {
  return (
    conversation.activeRunStatus === "queued" ||
    conversation.activeRunStatus === "running" ||
    conversation.planStatus === "executing" ||
    conversation.planStatus === "verifying"
  );
}

export function AIConversationStatusIndicator({
  conversation,
}: {
  conversation: AIConversationSummary;
}) {
  if (isConversationProgressActive(conversation)) {
    return <AIProgressRing ariaLabel={`${conversation.title} in progress`} />;
  }

  const StatusIcon = getConversationStatusIcon(conversation);
  return <StatusIcon className={getConversationStatusIconClassName(conversation)} />;
}

function getConversationStatusIconClassName(conversation: AIConversationSummary) {
  return cn(
    "h-4 w-4 shrink-0",
    conversation.activeRunStatus === "waiting_for_approval" ||
      conversation.activeRunStatus === "waiting_for_answer" ||
      conversation.activeRunStatus === "waiting_for_credential" ||
      conversation.activeRunStatus === "waiting_for_setup"
      ? "text-warning-foreground"
      : conversation.planStatus === "awaiting_decision" || conversation.planStatus === "paused"
        ? "text-warning-foreground"
        : ""
  );
}
