import { screen } from "@testing-library/react";
import { useAIStore } from "@/stores/ai";
import { useUIStore } from "@/stores/ui";
import { exportScreen } from "../harness";
import {
  AI_CONVERSATION_ID,
  aiConversation,
  aiMessages,
  aiPanelHandlers,
  earlierConversations,
} from "../fixtures/edge/ai-panel";
import { nodeDetailHandlers } from "../fixtures/edge/node-detail";
import { aiStatus } from "../fixtures/shell";

it("state-ai-side-panel", async () => {
  await exportScreen({
    id: "state-ai-side-panel",
    title: "AI side panel",
    group: "States",
    route: "/nodes/edge-fra-1",
    handlers: [...aiPanelHandlers(), ...nodeDetailHandlers()],
    height: 900,
    before: () => {
      useUIStore.setState({ aiPanelOpen: true, aiLiteMode: false });
      useAIStore.setState({
        messages: aiMessages,
        activeConversationId: AI_CONVERSATION_ID,
        savedName: aiConversation.title,
        recentConversations: [aiConversation, ...earlierConversations],
        isConnected: true,
        isConnecting: false,
        connectionError: null,
        isStreaming: false,
        isEnabled: true,
        providerStatus: aiStatus as never,
        selectedModel: aiStatus.defaultModel,
        selectedReasoningEffort: aiStatus.defaultReasoningEffort,
      });
    },
    ready: async () => {
      await screen.findByText(/Its health check has answered/);
    },
    interact: async (user) => {
      // Show the tool calls the assistant made instead of the collapsed summary row.
      await user.click(screen.getByRole("button", { name: "Called 3 tools" }));
      await screen.findByRole("button", { name: /get docker container logs/i });
    },
    notes: [
      "AI side panel open on the Edge Frankfurt node page, with a finished Work Session about the degraded grafana route.",
    ],
  });
});
