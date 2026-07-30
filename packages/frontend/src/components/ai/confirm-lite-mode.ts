import { confirm } from "@/components/common/ConfirmDialog";
import { useUIStore } from "@/stores/ui";

export async function confirmAILiteMode() {
  const state = useUIStore.getState();
  if (state.aiLiteModeIntroAccepted) return true;

  const confirmed = await confirm({
    title: "Switch to lite mode",
    description:
      "Lite mode turns Gateway into an AI-first workspace. The assistant becomes the main screen, the sidebar switches to recent conversations, and Settings or Administration stay available from the account menu. It is useful for operators who mostly ask the assistant to inspect, explain, and perform infrastructure tasks without navigating every resource page. You can exit lite mode anytime from the AI header and return to the normal Gateway layout.",
    confirmLabel: "Enable",
    cancelLabel: "Back",
    cancelVariant: "ghost",
    variant: "default",
  });
  if (confirmed) useUIStore.getState().setAILiteModeIntroAccepted(true);
  return confirmed;
}
