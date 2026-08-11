import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AIConversationBlock } from "@/stores/ai";

interface AIConversationBlockedBlockProps {
  block: AIConversationBlock;
  onNewChat: () => void;
  showTopBorder?: boolean;
}

export function AIConversationBlockedBlock({
  block,
  onNewChat,
  showTopBorder = true,
}: AIConversationBlockedBlockProps) {
  const isContextBlocked = block.status === "context_blocked";

  return (
    <div
      className={
        showTopBorder ? "border-t border-border bg-muted/40 px-3 py-3" : "bg-muted/40 px-3 py-3"
      }
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {isContextBlocked ? "Context limit reached" : "Conversation ended"}
            </p>
            <p className="text-sm text-muted-foreground">{block.reason}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          <Button onClick={onNewChat}>New Work Session</Button>
        </div>
      </div>
    </div>
  );
}
