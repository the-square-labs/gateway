import { screen } from "@testing-library/react";
import { useAIStore } from "@/stores/ai";
import {
  AI_CONVERSATION_ID,
  aiConversation,
  aiMessages,
  aiPanelHandlers,
} from "../fixtures/edge/ai-panel";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { aiSessions, aiWorkspaceHandlers } from "../fixtures/overview/ai-workspace";
import { aiStatus } from "../fixtures/shell";
import { exportScreen } from "../harness";

it("overview-ai-chat", async () => {
  await exportScreen({
    id: "overview-ai-chat",
    title: "AI Workspace · Work Session",
    group: "Overview",
    route: `/ai/chats/${AI_CONVERSATION_ID}`,
    handlers: [...aiWorkspaceHandlers(), ...aiPanelHandlers(), ...backgroundPrewarmHandlers()],
    before: () => {
      useAIStore.setState({
        messages: aiMessages,
        activeConversationId: AI_CONVERSATION_ID,
        savedName: aiConversation.title,
        recentConversations: aiSessions,
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
    notes: [
      "The full-screen AI Workspace on a finished Work Session about the degraded grafana route.",
      "Sidebar: six Work Sessions, three of them in the Incidents and Releases folders.",
    ],
  });
});
