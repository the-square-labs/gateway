import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAIStore } from "@/stores/ai";
import { useUIStore } from "@/stores/ui";

interface AIButtonProps {
  iconOnly?: boolean;
}

export function AIButton({ iconOnly = false }: AIButtonProps) {
  const { toggleAIPanel, aiPanelOpen, aiLiteMode } = useUIStore();
  const isEnabled = useAIStore((s) => s.isEnabled);

  const handleClick = () => {
    if (aiLiteMode) {
      window.dispatchEvent(new CustomEvent("gateway:open-ai-workspace"));
      return;
    }
    toggleAIPanel();
  };

  if (isEnabled === false) return null;

  if (iconOnly) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`h-8 w-8 ${aiPanelOpen ? "bg-sidebar-accent text-primary" : ""}`}
            onClick={handleClick}
          >
            <Sparkles className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">AI Workspace (⌘I)</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`h-10 w-10 md:h-7 md:w-7 ${aiPanelOpen ? "text-primary" : ""}`}
          onClick={handleClick}
        >
          <Sparkles className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>AI Workspace (⌘I)</TooltipContent>
    </Tooltip>
  );
}
