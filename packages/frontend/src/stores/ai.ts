import { toast } from "sonner";
import { create } from "zustand";
import {
  type AIConversationFolder,
  type AIConversationSummary,
  createConversationFolder,
  deleteConversation,
  deleteConversationFolder,
  getConversation,
  listConversationFolders,
  listConversations,
  moveConversationsToFolder,
  renameConversation,
  reorderConversationFolders,
  rollbackConversationToMessage,
  updateConversationFolder,
  updateConversationProvider,
} from "@/services/ai-conversations";
import { AIWebSocketClient } from "@/services/ai-websocket";
import { api } from "@/services/api";
import { invalidateToolStore } from "@/services/tool-store-invalidation";
import { applyAssistantResourcePinAction } from "@/stores/assistant-resource-pins";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import type {
  AIConfig,
  AIConversationInput,
  AIConversationRuntimeSnapshot,
  AIConversationStatus,
  AICredentialChallenge,
  AIMessage,
  AIPlanRuntimeSnapshot,
  AIProviderStatus,
  AIResourceReference,
  AIRunToolCall,
  AIScenario,
  AISetupInteraction,
  AIToolCall,
  ChatMessage,
  PageContext,
  WSServerMessage,
} from "@/types/ai";

const DEFAULT_CONTEXT_TOKEN_LIMIT = 56000;
const DEFAULT_REASONING_EFFORT: AIConfig["reasoningEffort"] = "none";
const CONTEXT_ESTIMATE_CACHE_TTL_MS = 30_000;
const AI_MODEL_STORAGE_KEY = "gateway:ai:selected-model";
const AI_REASONING_STORAGE_PREFIX = "gateway:ai:reasoning-effort:";

function loadStoredAIModel(): string | null {
  try {
    return window.localStorage.getItem(AI_MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeAIModel(model: string | null): void {
  try {
    if (model) window.localStorage.setItem(AI_MODEL_STORAGE_KEY, model);
    else window.localStorage.removeItem(AI_MODEL_STORAGE_KEY);
  } catch {
    // Local preferences are best-effort.
  }
}

function loadStoredAIReasoningEffort(model: string | null): string | null {
  if (!model) return null;
  try {
    return window.localStorage.getItem(`${AI_REASONING_STORAGE_PREFIX}${model}`);
  } catch {
    return null;
  }
}

function storeAIReasoningEffort(model: string, effort: string | null): void {
  try {
    if (effort) window.localStorage.setItem(`${AI_REASONING_STORAGE_PREFIX}${model}`, effort);
    else window.localStorage.removeItem(`${AI_REASONING_STORAGE_PREFIX}${model}`);
  } catch {
    // Local preferences are best-effort.
  }
}

function resolveReasoningEffort(
  status: AIProviderStatus | null,
  model: string | null
): string | null {
  const option = status?.models.find((candidate) => candidate.id === model);
  const stored = loadStoredAIReasoningEffort(model);
  return option?.reasoningEfforts.includes(stored ?? "")
    ? stored
    : option?.defaultReasoningEffort || option?.reasoningEfforts[0] || null;
}

function resolveDraftProviderSelection(
  status: AIProviderStatus | null
): Pick<AIState, "selectedModel" | "selectedReasoningEffort"> {
  if (status?.providerType === "openai_compatible") {
    const stored = loadStoredAIReasoningEffort(status.defaultModel);
    return {
      selectedModel: null,
      selectedReasoningEffort:
        status.allowUserReasoningEffortSelection &&
        (status.reasoningEfforts ?? []).includes(stored ?? "")
          ? stored
          : status.allowUserReasoningEffortSelection
            ? (status.defaultReasoningEffort ?? null)
            : null,
    };
  }
  if (status?.providerType !== "gateway_inference" || status.models.length === 0) {
    return { selectedModel: null, selectedReasoningEffort: null };
  }
  const storedModel = loadStoredAIModel();
  const selectedModel =
    status.allowUserModelSelection && status.models.some((model) => model.id === storedModel)
      ? storedModel
      : status.defaultModel || status.models[0]?.id || null;
  return {
    selectedModel,
    selectedReasoningEffort: resolveReasoningEffort(status, selectedModel),
  };
}

function canSendSelectedReasoningEffort(status: AIProviderStatus | null): boolean {
  return (
    status?.providerType === "gateway_inference" ||
    (status?.providerType === "openai_compatible" &&
      status.allowUserReasoningEffortSelection === true)
  );
}

interface AIContextOverheadEstimate {
  chatTokens: number;
  messageCount: number;
  systemTokens: number;
  toolsTokens: number;
  overheadTokens: number;
  limit: number;
  source: "server" | "settings" | "fallback";
  reasoningEffort: string;
  toolCount: number;
  systemBreakdown: Array<{
    label: string;
    chars: number;
    tokens: number;
  }>;
  toolBreakdown: Array<{
    label: string;
    chars: number;
    tokens: number;
  }>;
}

let contextEstimateCache: {
  key: string;
  expiresAt: number;
  estimate: AIContextOverheadEstimate;
} | null = null;
const contextEstimateRequests = new Map<string, Promise<AIContextOverheadEstimate>>();

async function resolveContextSettings(): Promise<{
  limit: number;
  source: "settings" | "fallback";
  reasoningEffort: string;
}> {
  const cached = api.getCached<AIConfig>("settings:ai-config");
  if (cached?.maxContextTokens) {
    return {
      limit: cached.maxContextTokens,
      source: "settings",
      reasoningEffort: cached.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    };
  }

  try {
    const config = (await api.getAIConfig()) as unknown as AIConfig;
    api.setCache("settings:ai-config", config);
    if (config.maxContextTokens) {
      return {
        limit: config.maxContextTokens,
        source: "settings",
        reasoningEffort: config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      };
    }
  } catch {
    // Fall through to the legacy estimate when settings are unavailable.
  }

  return {
    limit: DEFAULT_CONTEXT_TOKEN_LIMIT,
    source: "fallback",
    reasoningEffort: DEFAULT_REASONING_EFFORT,
  };
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateUuid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
      const value = (Math.random() * 16) | 0;
      return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
    })
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function compactToolResultForModel(toolName: string, value: unknown): unknown {
  if (value == null) return value;
  if (toolName === "send_artifact" && typeof value === "object" && value !== null) {
    const { artifactId, filename, mediaType, sizeBytes, sourcePath, downloadUrl } = value as Record<
      string,
      unknown
    >;
    return { artifactId, filename, mediaType, sizeBytes, sourcePath, downloadUrl };
  }
  return value;
}

interface AIState {
  messages: AIMessage[];
  queuedInputs: AIConversationInput[];
  resourceReferences: AIResourceReference[];
  recentConversations: AIConversationSummary[];
  conversationFolders: AIConversationFolder[];
  isLoadingRecentConversations: boolean;
  isLoadingConversationFolders: boolean;
  isStreaming: boolean;
  isStartingConversation: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  connectionError: string | null;
  isEnabled: boolean | null;
  retryAfter: number | null;
  savedName: string | null;
  activeConversationId: string | null;
  sidebarActiveConversationId: string | null;
  activeRunId: string | null;
  activePlan: AIPlanRuntimeSnapshot | null;
  plans: AIPlanRuntimeSnapshot[];
  dismissedPlanDecisionKey: string | null;
  devPlanProgressPreview: AIPlanRuntimeSnapshot | null;
  workMode: "normal" | "plan";
  canContinueConversation: boolean;
  isCompactingContext: boolean;
  lastContext: PageContext | null;
  pendingApprovalToolCallId: string | null;
  pendingCredentialChallenge: AICredentialChallenge | null;
  pendingSetupInteraction: AISetupInteraction | null;
  providerStatus: AIProviderStatus | null;
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  contextUsageDialog: AIContextUsage | null;

  // Actions
  connect: () => Promise<boolean>;
  disconnect: () => void;
  sendMessage: (
    content: string,
    context?: PageContext,
    attachments?: AIMessage["attachments"],
    options?: SendMessageOptions
  ) => void;
  startScenario: (scenario: AIScenario, context?: PageContext) => void;
  queueMessage: (
    content: string,
    context?: PageContext,
    attachments?: AIMessage["attachments"]
  ) => void;
  steerQueuedMessage: (inputId: string) => void;
  cancelQueuedMessage: (inputId: string) => void;
  continueConversation: (context?: PageContext) => void;
  approveTool: (toolCallId: string) => void;
  rejectTool: (toolCallId: string) => void;
  answerQuestion: (toolCallId: string, answer: string) => void;
  resolveCredentialChallenge: (decision: "authorized" | "rejected") => void;
  resolveSetupInteraction: (
    status: "configured" | "cancelled",
    result?: Record<string, unknown>
  ) => void;
  stopStreaming: () => void;
  setWorkMode: (mode: "normal" | "plan") => void;
  abandonPlanning: () => void;
  decidePlan: (decision: "implement" | "refine" | "custom", customInstruction?: string) => void;
  pausePlan: () => void;
  resumePlan: () => void;
  cancelPlan: () => void;
  clearMessages: () => void;
  fetchRecentConversations: () => Promise<void>;
  fetchConversationFolders: () => Promise<void>;
  createConversationFolder: (input: {
    name: string;
    description?: string;
  }) => Promise<AIConversationFolder | null>;
  updateConversationFolder: (
    id: string,
    input: { name?: string; description?: string }
  ) => Promise<AIConversationFolder | null>;
  deleteConversationFolder: (id: string) => Promise<void>;
  reorderConversationFolders: (folderIds: string[]) => Promise<void>;
  moveConversationsToFolder: (conversationIds: string[], folderId: string | null) => Promise<void>;
  loadConversation: (conversationId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  rollbackToMessage: (messageId: string) => Promise<AIMessage | null>;
  retryMessage: (messageId: string) => Promise<void>;
  setEnabled: (enabled: boolean) => void;
  setProviderStatus: (status: AIProviderStatus) => void;
  refreshProviderStatus: () => Promise<void>;
  setSelectedModel: (model: string) => Promise<void>;
  setSelectedReasoningEffort: (effort: string) => Promise<void>;
  handleSlashCommand: (input: string) => Promise<boolean>;
  closeContextUsageDialog: () => void;
  setMessages: (messages: AIMessage[]) => void;
}

let wsClient: AIWebSocketClient | null = null;
let conversationLoadGeneration = 0;
const pendingToolCommands = new Map<
  string,
  {
    toolCallId: string;
    previousStatus: AIToolCall["status"];
    previousResult?: unknown;
    decision: "approval" | "question";
    approvalDecision?: "approved" | "rejected";
  }
>();
const pendingInputCommands = new Map<
  string,
  {
    kind: "queue" | "steer" | "cancel";
    input: AIConversationInput;
  }
>();
const observedPlanStatuses = new Map<string, AIPlanRuntimeSnapshot["status"]>();
const cancelledPlanTombstones = new Map<string, { planId: string; clientCommandId: string }>();
const pendingPlanCancellationCommands = new Map<
  string,
  { conversationId: string; plan: AIPlanRuntimeSnapshot }
>();
const pendingSetupCommands = new Map<string, AISetupInteraction>();

declare global {
  interface Window {
    gatewayDev?: {
      showApprovalBlock?: () => void;
      hideApprovalBlock?: () => void;
      showChangedResources?: () => void;
      hideChangedResources?: () => void;
      showPlanProgress?: () => void;
      hidePlanProgress?: () => void;
      [key: string]: unknown;
    };
  }
}

function updateToolCallById(
  messages: AIMessage[],
  toolCallId: string,
  update: (toolCall: AIToolCall) => AIToolCall
): AIMessage[] {
  return messages.map((msg) => ({
    ...msg,
    toolCalls: msg.toolCalls?.map((tc) => (tc.id === toolCallId ? update(tc) : tc)),
  }));
}

function appendLocalAssistantError(messages: AIMessage[], content: string): AIMessage[] {
  if (!content.trim()) return messages;
  return [
    ...messages,
    {
      id: generateId(),
      role: "assistant",
      content,
      createdAt: nowIso(),
      localOnly: true,
    },
  ];
}

function appendPendingSteerMessage(messages: AIMessage[], input: AIConversationInput): AIMessage[] {
  const id = `steer:${input.id}`;
  if (messages.some((message) => message.id === id)) return messages;
  return [
    ...messages,
    {
      id,
      role: "user",
      content: input.content,
      attachments: input.attachments,
      createdAt: input.createdAt,
      localOnly: true,
      steer: true,
      steerPending: true,
    },
  ];
}

function appendPendingSteerMessages(
  messages: AIMessage[],
  inputs: AIConversationInput[]
): AIMessage[] {
  return inputs
    .filter((input) => input.mode === "steer" && input.status === "pending")
    .reduce(appendPendingSteerMessage, messages);
}

function startingAssistantMessageId(clientCommandId: string): string {
  return `starting:${clientCommandId}:assistant`;
}

function removeStartingAssistantMessage(
  messages: AIMessage[],
  clientCommandId?: string
): AIMessage[] {
  const exactId = clientCommandId ? startingAssistantMessageId(clientCommandId) : null;
  return messages.filter(
    (message) =>
      message.id !== exactId &&
      !(exactId === null && message.id.startsWith("starting:") && message.id.endsWith(":assistant"))
  );
}

function sendWSMessage(msg: Parameters<AIWebSocketClient["send"]>[0]): void {
  if (!wsClient) throw new Error("AI connection is not open");
  wsClient.send(msg);
}

function trySendWSMessage(msg: Parameters<AIWebSocketClient["send"]>[0]): boolean {
  try {
    sendWSMessage(msg);
    return true;
  } catch {
    return false;
  }
}
const assistantDraftVersions = new Map<string, number>();
const completedAssistantCommentVersions = new Map<string, number>();
const terminalAssistantRuns = new Set<string>();
const appliedConversationRevisions = new Map<string, number>();
const assistantDeltaBuffers = new Map<
  string,
  {
    kind: "assistant" | "comment";
    content: string;
    version: number;
    message: Extract<WSServerMessage, { type: "assistant.delta" | "assistant.comment_delta" }>;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const ASSISTANT_DELTA_BATCH_MS = 50;
const ASSISTANT_DELTA_BATCH_WORDS = 3;

function acceptConversationRevision(conversationId: string, revision: number | undefined): boolean {
  if (typeof revision !== "number") return true;
  const appliedRevision = appliedConversationRevisions.get(conversationId);
  if (appliedRevision !== undefined && revision < appliedRevision) return false;
  appliedConversationRevisions.set(conversationId, revision);
  return true;
}

function upsertTimelinePlan(
  plans: AIPlanRuntimeSnapshot[],
  plan: AIPlanRuntimeSnapshot
): AIPlanRuntimeSnapshot[] {
  if (!plan.revisionId || !plan.publishedAt) return plans;
  return [...plans.filter((candidate) => candidate.revisionId !== plan.revisionId), plan].sort(
    (left, right) =>
      new Date(left.timelineAnchorAt ?? left.publishedAt ?? left.createdAt).getTime() -
      new Date(right.timelineAnchorAt ?? right.publishedAt ?? right.createdAt).getTime()
  );
}

export interface AIConversationBlock {
  status: Exclude<AIConversationStatus, "active">;
  reason: string;
}

export function getConversationBlock(messages: AIMessage[]): AIConversationBlock | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.compactMarker) return null;
    if (message.conversationStatus) {
      return {
        status: message.conversationStatus,
        reason: message.blockReason || "This conversation cannot continue.",
      };
    }
  }
  return null;
}

function activeModelMessages(messages: AIMessage[]): AIMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].compactMarker) {
      if (messages[i].compactVersion === 2 && messages[i].compactBoundaryMessageId) {
        const boundaryIndex = messages.findIndex(
          (message) => message.id === messages[i].compactBoundaryMessageId
        );
        if (boundaryIndex >= 0 && boundaryIndex < i) {
          return [messages[i], ...messages.slice(boundaryIndex + 1, i), ...messages.slice(i + 1)];
        }
      }
      const tailCount = Math.max(0, Math.trunc(messages[i].compactTailMessageCount ?? 0));
      const tailStart = Math.max(0, i - tailCount);
      return [messages[i], ...messages.slice(tailStart, i), ...messages.slice(i + 1)];
    }
  }
  return messages;
}

function buildChatMessages(messages: AIMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const msg of activeModelMessages(messages)) {
    if (msg.localOnly || msg.conversationStatus) continue;
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content, attachments: msg.attachments });
    } else if (msg.role === "assistant") {
      const chatMsg: ChatMessage = { role: "assistant", content: msg.content || null };

      // Build tool_calls from rawToolCalls or reconstruct from toolCalls
      if (msg.rawToolCalls?.length) {
        chatMsg.tool_calls = msg.rawToolCalls as ChatMessage["tool_calls"];
      } else if (msg.toolCalls?.length) {
        chatMsg.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }

      result.push(chatMsg);

      // Add tool results after the assistant message
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.status === "completed" || tc.status === "failed" || tc.status === "rejected") {
            const content = tc.error
              ? JSON.stringify({ error: tc.error })
              : tc.result !== undefined
                ? JSON.stringify(compactToolResultForModel(tc.name, tc.result))
                : "{}";
            result.push({
              role: "tool",
              tool_call_id: tc.id,
              content,
              name: tc.name,
            });
          }
        }
      }
    }
  }
  return result;
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateChatMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === "string") total += estimateTextTokens(message.content);
    if (message.attachments?.length) {
      for (const attachment of message.attachments) {
        total += Math.ceil(attachment.sizeBytes / 3);
      }
    }
    if (message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        total += estimateTextTokens(toolCall.function.arguments || "");
        total += 20;
      }
    }
    total += 4;
  }
  return total;
}

function contextEstimateCacheKey(
  messages: ChatMessage[],
  context?: PageContext,
  conversationId?: string | null,
  model?: string | null,
  reasoningEffort?: string | null
): string {
  return JSON.stringify({
    messages: chatMessagesFingerprint(messages),
    conversationId: conversationId ?? null,
    model: model ?? null,
    reasoningEffort: reasoningEffort ?? null,
    route: context?.route ?? null,
    resourceType: context?.resourceType ?? null,
    resourceId: context?.resourceId ?? null,
  });
}

function chatMessagesFingerprint(messages: ChatMessage[]): string {
  let hash = 2166136261;
  const value = JSON.stringify(messages);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${messages.length}:${hash >>> 0}`;
}

async function resolveContextOverhead(
  messages: ChatMessage[],
  context?: PageContext,
  conversationId?: string | null,
  model?: string | null,
  reasoningEffort?: string | null
): Promise<AIContextOverheadEstimate> {
  const key = contextEstimateCacheKey(messages, context, conversationId, model, reasoningEffort);
  const now = Date.now();
  if (contextEstimateCache?.key === key && contextEstimateCache.expiresAt > now) {
    return contextEstimateCache.estimate;
  }

  const existingRequest = contextEstimateRequests.get(key);
  if (existingRequest) return existingRequest;

  const request = (async () => {
    try {
      const estimate = await api.getAIContextEstimate({
        messages,
        context,
        conversationId,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
      const result: AIContextOverheadEstimate = {
        chatTokens: estimate.chatTokens,
        messageCount: estimate.messageCount,
        systemTokens: estimate.systemTokens,
        toolsTokens: estimate.toolsTokens,
        overheadTokens: estimate.totalOverhead,
        limit: estimate.limit,
        source: "server",
        reasoningEffort: estimate.reasoningEffort,
        toolCount: estimate.toolCount,
        systemBreakdown: estimate.systemBreakdown ?? [],
        toolBreakdown: estimate.toolBreakdown ?? [],
      };
      contextEstimateCache = {
        key,
        expiresAt: Date.now() + CONTEXT_ESTIMATE_CACHE_TTL_MS,
        estimate: result,
      };
      return result;
    } catch {
      const { limit, source, reasoningEffort } = await resolveContextSettings();
      const result: AIContextOverheadEstimate = {
        chatTokens: estimateChatMessagesTokens(messages),
        messageCount: messages.length,
        systemTokens: 0,
        toolsTokens: 0,
        overheadTokens: 0,
        limit,
        source,
        reasoningEffort,
        toolCount: 0,
        systemBreakdown: [],
        toolBreakdown: [],
      };
      contextEstimateCache = {
        key,
        expiresAt: Date.now() + CONTEXT_ESTIMATE_CACHE_TTL_MS,
        estimate: result,
      };
      return result;
    } finally {
      contextEstimateRequests.delete(key);
    }
  })();
  contextEstimateRequests.set(key, request);
  return request;
}

export interface AIContextUsage {
  messageCount: number;
  estimatedTokens: number;
  limit: number;
  percent: number;
  chatTokens: number;
  systemTokens: number;
  toolsTokens: number;
  overheadTokens: number;
  toolCount: number;
  systemBreakdown: Array<{
    label: string;
    chars: number;
    tokens: number;
  }>;
  toolBreakdown: Array<{
    label: string;
    chars: number;
    tokens: number;
  }>;
  source: "server" | "settings" | "fallback";
  reasoningEffort: string;
}

interface SendMessageOptions {
  startNewConversation?: boolean;
}

export async function getAIContextUsage(
  messages: AIMessage[],
  context?: PageContext,
  conversationId?: string | null,
  model?: string | null,
  reasoningEffort?: string | null
): Promise<AIContextUsage> {
  const chatMessages = buildChatMessages(messages);
  const overhead = await resolveContextOverhead(
    chatMessages,
    context,
    conversationId,
    model,
    reasoningEffort
  );
  const overheadTokens = overhead.overheadTokens;
  const chatTokens = overhead.chatTokens;
  const estimatedTokens = chatTokens + overheadTokens;

  return {
    messageCount: overhead.messageCount,
    estimatedTokens,
    limit: overhead.limit,
    percent: Math.round((estimatedTokens / overhead.limit) * 100),
    chatTokens,
    systemTokens: overhead.systemTokens,
    toolsTokens: overhead.toolsTokens,
    overheadTokens,
    toolCount: overhead.toolCount,
    systemBreakdown: overhead.systemBreakdown,
    toolBreakdown: overhead.toolBreakdown,
    source: overhead.source,
    reasoningEffort: overhead.reasoningEffort,
  };
}

export const useAIStore = create<AIState>()((set, get) => ({
  messages: [],
  queuedInputs: [],
  resourceReferences: [],
  recentConversations: [],
  conversationFolders: [],
  isLoadingRecentConversations: false,
  isLoadingConversationFolders: false,
  isStreaming: false,
  isStartingConversation: false,
  isConnected: false,
  isConnecting: false,
  connectionError: null,
  isEnabled: null,
  retryAfter: null,
  savedName: null,
  activeConversationId: null,
  sidebarActiveConversationId: null,
  activeRunId: null,
  activePlan: null,
  plans: [],
  dismissedPlanDecisionKey: null,
  devPlanProgressPreview: null,
  workMode: "normal",
  canContinueConversation: false,
  isCompactingContext: false,
  lastContext: null,
  pendingApprovalToolCallId: null,
  pendingCredentialChallenge: null,
  pendingSetupInteraction: null,
  providerStatus: null,
  selectedModel: loadStoredAIModel(),
  selectedReasoningEffort: loadStoredAIReasoningEffort(loadStoredAIModel()),
  contextUsageDialog: null,

  connect: async () => {
    const auth = useAuthStore.getState();
    if (!auth.user && auth.isLoading) {
      set({ isConnecting: true, connectionError: null });
      return false;
    }
    if (!auth.user) {
      set({ isConnecting: false, connectionError: "Not authenticated" });
      return false;
    }
    void get()
      .refreshProviderStatus()
      .catch(() => {});
    if (wsClient?.isConnected) {
      set({ isConnected: true, isConnecting: false, connectionError: null });
      return true;
    }
    if (wsClient) {
      return false;
    }

    const client = new AIWebSocketClient();
    wsClient = client;
    set({ isConnecting: true, connectionError: null });
    client.onMessage((msg: WSServerMessage) => {
      if (wsClient !== client) return;
      handleWSMessage(msg, set, get);
    });
    client.onStatusChange((connected) => {
      if (wsClient !== client) return;
      set({
        isConnected: connected,
        isConnecting: false,
        connectionError: connected ? null : get().connectionError,
      });
      const activeConversationId = get().activeConversationId;
      if (connected && activeConversationId) {
        trySendWSMessage({ type: "conversation.subscribe", conversationId: activeConversationId });
      }
      if (!connected) {
        set((state) => ({
          isStreaming: false,
          isStartingConversation: false,
          isCompactingContext: false,
          messages: removeStartingAssistantMessage(state.messages),
        }));
      }
    });
    client.onConnectionError((message) => {
      if (wsClient !== client) return;
      set({ connectionError: message, isConnecting: false });
    });

    const ok = await client.connect();
    if (wsClient !== client) return false;
    if (!ok) {
      const currentError = get().connectionError;
      const transientFailure = currentError === null || currentError === "Reconnecting...";
      set({
        isConnecting: false,
        isConnected: false,
        connectionError: transientFailure ? "Reconnecting..." : currentError,
      });
    }
    return ok;
  },

  disconnect: () => {
    wsClient?.disconnect();
    wsClient = null;
    set((state) => ({
      isConnected: false,
      isConnecting: false,
      connectionError: null,
      isStreaming: false,
      isStartingConversation: false,
      isCompactingContext: false,
      messages: removeStartingAssistantMessage(state.messages),
    }));
  },

  sendMessage: (
    content: string,
    context?: PageContext,
    attachments: AIMessage["attachments"] = [],
    options: SendMessageOptions = {}
  ) => {
    const state = get();
    const baseMessages = options.startNewConversation ? [] : state.messages;
    if ((!options.startNewConversation && state.isStreaming) || getConversationBlock(baseMessages))
      return;
    if (options.startNewConversation && state.activeConversationId) {
      trySendWSMessage({
        type: "conversation.unsubscribe",
        conversationId: state.activeConversationId,
      });
    }
    if (options.startNewConversation) conversationLoadGeneration += 1;
    const clientCommandId = generateId();

    set({
      isStreaming: true,
      canContinueConversation: false,
      isStartingConversation: options.startNewConversation === true,
      isCompactingContext: false,
      lastContext: context ?? null,
      pendingApprovalToolCallId: null,
      pendingCredentialChallenge: null,
      pendingSetupInteraction: null,
      workMode: state.workMode,
      messages: [
        ...baseMessages,
        {
          id: `starting:${clientCommandId}:user`,
          role: "user",
          content,
          attachments,
          clientCommandId,
          createdAt: nowIso(),
          localOnly: true,
        },
        {
          id: startingAssistantMessageId(clientCommandId),
          role: "assistant",
          content: "",
          clientCommandId,
          createdAt: nowIso(),
          isStreaming: true,
        },
      ],
      ...(options.startNewConversation
        ? {
            queuedInputs: [],
            resourceReferences: [],
            savedName: null,
            activeConversationId: null,
            sidebarActiveConversationId: null,
            activeRunId: null,
            activePlan: null,
            plans: [],
            isCompactingContext: false,
          }
        : {}),
    });

    try {
      sendWSMessage({
        type: "conversation.send_message",
        clientCommandId,
        content,
        attachments,
        context,
        ...(state.providerStatus?.providerType === "gateway_inference" && state.selectedModel
          ? { model: state.selectedModel }
          : {}),
        ...(canSendSelectedReasoningEffort(state.providerStatus) && state.selectedReasoningEffort
          ? { reasoningEffort: state.selectedReasoningEffort }
          : {}),
        ...(state.workMode === "plan" ? { workMode: "plan" as const } : {}),
        conversationId: options.startNewConversation
          ? undefined
          : (state.activeConversationId ?? undefined),
      });
    } catch (error) {
      set((state) => ({
        isStreaming: false,
        isStartingConversation: false,
        isCompactingContext: false,
        messages: appendLocalAssistantError(
          removeStartingAssistantMessage(state.messages, clientCommandId),
          `**Error:** ${error instanceof Error ? error.message : "Failed to send message"}`
        ),
      }));
    }
  },

  startScenario: (scenario: AIScenario, context?: PageContext) => {
    const state = get();
    const currentConversationIsRunning =
      state.isStartingConversation ||
      (state.activeConversationId !== null && state.messages.length > 0 && state.isStreaming);
    if (currentConversationIsRunning || getConversationBlock(state.messages)) return;
    if (state.activeConversationId) {
      trySendWSMessage({
        type: "conversation.unsubscribe",
        conversationId: state.activeConversationId,
      });
    }
    conversationLoadGeneration += 1;
    const clientCommandId = generateUuid();
    set({
      isStreaming: true,
      isStartingConversation: true,
      pendingCredentialChallenge: null,
      pendingSetupInteraction: null,
      // A scenario starts by gathering requirements. Its plan mode is shown only
      // once the assistant has actually produced a plan for the conversation.
      workMode: "normal",
      messages: [
        {
          id: `starting:${clientCommandId}:user`,
          role: "user",
          content: scenario.title,
          scenario,
          createdAt: nowIso(),
          localOnly: true,
        },
        {
          id: startingAssistantMessageId(clientCommandId),
          role: "assistant",
          content: "",
          createdAt: nowIso(),
          isStreaming: true,
        },
      ],
      queuedInputs: [],
      resourceReferences: [],
      savedName: null,
      activeConversationId: null,
      sidebarActiveConversationId: null,
      activeRunId: null,
      activePlan: null,
      plans: [],
      isCompactingContext: false,
    });
    try {
      sendWSMessage({
        type: "conversation.start_scenario",
        clientCommandId,
        scenarioId: scenario.id,
        context,
        ...(state.providerStatus?.providerType === "gateway_inference" && state.selectedModel
          ? { model: state.selectedModel }
          : {}),
        ...(canSendSelectedReasoningEffort(state.providerStatus) && state.selectedReasoningEffort
          ? { reasoningEffort: state.selectedReasoningEffort }
          : {}),
      });
    } catch (error) {
      set((current) => ({
        isStreaming: false,
        isStartingConversation: false,
        messages: appendLocalAssistantError(
          removeStartingAssistantMessage(current.messages, clientCommandId),
          `**Error:** ${error instanceof Error ? error.message : "Failed to start scenario"}`
        ),
      }));
    }
  },

  setWorkMode: (workMode) => set({ workMode }),

  abandonPlanning: () => {
    const state = get();
    if (!state.activeConversationId) {
      set({ workMode: "normal" });
      return;
    }
    const clientCommandId = generateId();
    sendWSMessage({
      type: "conversation.abandon_planning",
      conversationId: state.activeConversationId,
      clientCommandId,
    });
    const publishedPlan = [
      ...state.plans,
      ...(state.activePlan?.publishedAt ? [state.activePlan] : []),
    ]
      .filter(
        (plan) =>
          plan.id === state.activePlan?.id &&
          plan.conversationId === state.activeConversationId &&
          Boolean(plan.publishedAt)
      )
      .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0))[0];
    const publishedDecisionKey = publishedPlan?.revisionId
      ? `${state.activeConversationId}:${publishedPlan.revisionId}`
      : null;
    set((current) => ({
      activeRunId: null,
      activePlan: publishedPlan ? { ...publishedPlan, status: "awaiting_decision" } : null,
      plans: publishedPlan
        ? current.plans
        : current.plans.filter(
            (plan) => !["drafting", "validating", "awaiting_decision"].includes(plan.status)
          ),
      isStreaming: false,
      isStartingConversation: false,
      pendingApprovalToolCallId: null,
      pendingCredentialChallenge: null,
      pendingSetupInteraction: null,
      dismissedPlanDecisionKey: publishedDecisionKey,
      workMode: "normal",
    }));
  },

  decidePlan: (decision, customInstruction) => {
    const { activeConversationId, activePlan } = get();
    if (!activeConversationId || !activePlan?.revisionId) return;
    const decisionKey = `${activeConversationId}:${activePlan.revisionId}`;
    if (decision === "refine") {
      set({ dismissedPlanDecisionKey: decisionKey, workMode: "plan" });
      return;
    }
    set({ dismissedPlanDecisionKey: null, workMode: "normal" });
    sendWSMessage({
      type: "plan.decide",
      conversationId: activeConversationId,
      planId: activePlan.id,
      revisionId: activePlan.revisionId,
      decision,
      ...(customInstruction?.trim() ? { customInstruction: customInstruction.trim() } : {}),
      clientCommandId: generateId(),
    });
  },

  pausePlan: () => {
    const { activeConversationId, activePlan } = get();
    if (!activeConversationId || !activePlan) return;
    sendWSMessage({
      type: "plan.pause",
      conversationId: activeConversationId,
      planId: activePlan.id,
      clientCommandId: generateId(),
    });
  },

  resumePlan: () => {
    const { activeConversationId, activePlan } = get();
    if (!activeConversationId || !activePlan) return;
    sendWSMessage({
      type: "plan.resume",
      conversationId: activeConversationId,
      planId: activePlan.id,
      clientCommandId: generateId(),
    });
  },

  cancelPlan: () => {
    const { activeConversationId, activePlan } = get();
    if (!activeConversationId || !activePlan) return;
    const clientCommandId = generateId();
    cancelledPlanTombstones.set(activeConversationId, { planId: activePlan.id, clientCommandId });
    pendingPlanCancellationCommands.set(clientCommandId, {
      conversationId: activeConversationId,
      plan: activePlan,
    });
    try {
      sendWSMessage({
        type: "plan.cancel",
        conversationId: activeConversationId,
        planId: activePlan.id,
        clientCommandId,
      });
    } catch (error) {
      cancelledPlanTombstones.delete(activeConversationId);
      pendingPlanCancellationCommands.delete(clientCommandId);
      toast.error(error instanceof Error ? error.message : "Failed to cancel plan");
      return;
    }
    set((state) => ({
      activePlan: null,
      plans: state.plans.map((plan) =>
        plan.id === activePlan.id ? { ...plan, status: "cancelled", updatedAt: nowIso() } : plan
      ),
      workMode: "normal",
    }));
  },

  queueMessage: (
    content: string,
    context?: PageContext,
    attachments: AIMessage["attachments"] = []
  ) => {
    const state = get();
    const text = content.trim();
    if (!state.activeConversationId || (!text && attachments.length === 0)) return;
    const inputId = generateUuid();
    const clientCommandId = generateId();
    const createdAt = nowIso();
    const input: AIConversationInput = {
      id: inputId,
      conversationId: state.activeConversationId,
      targetRunId: state.activeRunId,
      userId: "",
      clientCommandId,
      mode: "queued",
      status: "pending",
      content: text,
      attachments,
      context: context ?? null,
      consumedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    pendingInputCommands.set(clientCommandId, { kind: "queue", input });
    set((current) => ({ queuedInputs: [...current.queuedInputs, input] }));
    try {
      sendWSMessage({
        type: "conversation.queue_message",
        conversationId: state.activeConversationId,
        inputId,
        clientCommandId,
        content: text,
        attachments,
        context,
      });
    } catch {
      pendingInputCommands.delete(clientCommandId);
      set((current) => ({
        queuedInputs: current.queuedInputs.filter((item) => item.id !== inputId),
      }));
    }
  },

  steerQueuedMessage: (inputId: string) => {
    const state = get();
    if (!state.activeConversationId) return;
    const input = state.queuedInputs.find((item) => item.id === inputId);
    if (!input) return;
    const clientCommandId = generateId();
    pendingInputCommands.set(clientCommandId, { kind: "steer", input });
    set((current) => ({
      queuedInputs: current.queuedInputs.filter((item) => item.id !== inputId),
      messages: appendPendingSteerMessage(current.messages, { ...input, mode: "steer" }),
    }));
    try {
      sendWSMessage({
        type: "conversation.steer_message",
        conversationId: state.activeConversationId,
        inputId,
        clientCommandId,
      });
    } catch {
      pendingInputCommands.delete(clientCommandId);
      set((current) => ({
        queuedInputs: [...current.queuedInputs, input],
        messages: current.messages.filter((message) => message.id !== `steer:${inputId}`),
      }));
    }
  },

  cancelQueuedMessage: (inputId: string) => {
    const state = get();
    if (!state.activeConversationId) return;
    const input = state.queuedInputs.find((item) => item.id === inputId);
    if (!input) return;
    const clientCommandId = generateId();
    pendingInputCommands.set(clientCommandId, { kind: "cancel", input });
    set((current) => ({
      queuedInputs: current.queuedInputs.filter((item) => item.id !== inputId),
    }));
    try {
      sendWSMessage({
        type: "conversation.cancel_queued_message",
        conversationId: state.activeConversationId,
        inputId,
        clientCommandId,
      });
    } catch {
      pendingInputCommands.delete(clientCommandId);
      set((current) => ({ queuedInputs: [...current.queuedInputs, input] }));
    }
  },

  continueConversation: (context?: PageContext) => {
    const state = get();
    if (
      !state.activeConversationId ||
      state.isStreaming ||
      state.isCompactingContext ||
      !state.canContinueConversation ||
      getConversationBlock(state.messages)
    ) {
      return;
    }
    const clientCommandId = generateId();
    set({
      isStreaming: true,
      canContinueConversation: false,
      activeRunId: null,
      activePlan: null,
      plans: [],
      workMode: "normal",
      lastContext: context ?? state.lastContext,
      pendingApprovalToolCallId: null,
      pendingCredentialChallenge: null,
      pendingSetupInteraction: null,
    });
    try {
      sendWSMessage({
        type: "conversation.continue",
        conversationId: state.activeConversationId,
        clientCommandId,
        context: context ?? state.lastContext ?? undefined,
        ...(state.providerStatus?.providerType === "gateway_inference" && state.selectedModel
          ? { model: state.selectedModel }
          : {}),
        ...(canSendSelectedReasoningEffort(state.providerStatus) && state.selectedReasoningEffort
          ? { reasoningEffort: state.selectedReasoningEffort }
          : {}),
      });
    } catch (error) {
      set((current) => ({
        isStreaming: false,
        canContinueConversation: true,
        messages: appendLocalAssistantError(
          current.messages,
          `**Error:** ${error instanceof Error ? error.message : "Failed to continue conversation"}`
        ),
      }));
    }
  },

  approveTool: (toolCallId: string) => {
    const state = get();
    if (!state.activeConversationId || !state.activeRunId) return;
    const previous = state.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((toolCall) => toolCall.id === toolCallId);
    const clientCommandId = generateId();

    set((state) => ({
      messages: updateToolCallById(state.messages, toolCallId, (tc) => ({
        ...tc,
        status: "running",
        approvalPolicy: "requires_approval",
        approvalDecisionPending: true,
        error: undefined,
      })),
    }));
    pendingToolCommands.set(clientCommandId, {
      toolCallId,
      previousStatus: previous?.status ?? "awaiting_approval",
      previousResult: previous?.result,
      decision: "approval",
      approvalDecision: "approved",
    });
    try {
      sendWSMessage({
        type: "approval.decide",
        conversationId: state.activeConversationId,
        runId: state.activeRunId,
        approvalId: toolCallId,
        decision: "approved",
        clientCommandId,
      });
    } catch (error) {
      pendingToolCommands.delete(clientCommandId);
      set((state) => ({
        messages: updateToolCallById(state.messages, toolCallId, (tc) => ({
          ...tc,
          status: "awaiting_approval",
          approvalDecisionPending: false,
          result: previous?.result,
          error: error instanceof Error ? error.message : "Failed to send approval",
        })),
      }));
    }
  },

  rejectTool: (toolCallId: string) => {
    const state = get();
    if (!state.activeConversationId || !state.activeRunId) return;
    const previous = state.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((toolCall) => toolCall.id === toolCallId);
    const clientCommandId = generateId();

    set((state) => ({
      messages: updateToolCallById(state.messages, toolCallId, (tc) => ({
        ...tc,
        status: "rejected",
        approvalDecisionPending: true,
        error: undefined,
      })),
    }));
    pendingToolCommands.set(clientCommandId, {
      toolCallId,
      previousStatus: previous?.status ?? "awaiting_approval",
      previousResult: previous?.result,
      decision: "approval",
      approvalDecision: "rejected",
    });
    try {
      sendWSMessage({
        type: "approval.decide",
        conversationId: state.activeConversationId,
        runId: state.activeRunId,
        approvalId: toolCallId,
        decision: "rejected",
        clientCommandId,
      });
    } catch (error) {
      pendingToolCommands.delete(clientCommandId);
      set((state) => ({
        messages: updateToolCallById(state.messages, toolCallId, (tc) => ({
          ...tc,
          status: "awaiting_approval",
          approvalDecisionPending: false,
          result: previous?.result,
          error: error instanceof Error ? error.message : "Failed to send rejection",
        })),
      }));
    }
  },

  answerQuestion: (toolCallId: string, answer: string) => {
    const state = get();
    if (!state.activeConversationId || !state.activeRunId) return;

    const previous = state.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((toolCall) => toolCall.id === toolCallId);
    const clientCommandId = generateId();

    set((state) => ({
      messages: updateToolCallById(state.messages, toolCallId, (tc) => ({
        ...tc,
        status: "running",
        result: { answer },
        error: undefined,
      })),
      pendingApprovalToolCallId: null,
    }));
    pendingToolCommands.set(clientCommandId, {
      toolCallId,
      previousStatus: previous?.status ?? "awaiting_approval",
      previousResult: previous?.result,
      decision: "question",
    });
    try {
      sendWSMessage({
        type: "question.answer",
        conversationId: state.activeConversationId,
        runId: state.activeRunId,
        questionId: toolCallId,
        answer,
        clientCommandId,
      });
    } catch (error) {
      pendingToolCommands.delete(clientCommandId);
      set((state) => ({
        messages: updateToolCallById(state.messages, toolCallId, (tc) => ({
          ...tc,
          status: "awaiting_approval",
          result: previous?.result,
          error: error instanceof Error ? error.message : "Failed to send answer",
        })),
        pendingApprovalToolCallId: toolCallId,
      }));
    }
  },

  resolveCredentialChallenge: (decision: "authorized" | "rejected") => {
    const challenge = get().pendingCredentialChallenge;
    if (!challenge) return;
    sendWSMessage({
      type: "credential.resolve",
      conversationId: challenge.conversationId,
      runId: challenge.runId,
      challengeId: challenge.id,
      decision,
      clientCommandId: generateId(),
    });
  },

  resolveSetupInteraction: (status, result) => {
    const interaction = get().pendingSetupInteraction;
    if (!interaction) return;
    const clientCommandId = generateId();
    pendingSetupCommands.set(clientCommandId, interaction);
    try {
      sendWSMessage({
        type: "setup.resolve",
        conversationId: interaction.conversationId,
        runId: interaction.runId,
        interactionId: interaction.id,
        status,
        ...(result ? { result } : {}),
        clientCommandId,
      });
      set({ pendingSetupInteraction: null });
    } catch (error) {
      pendingSetupCommands.delete(clientCommandId);
      toast.error(error instanceof Error ? error.message : "Failed to continue setup");
    }
  },

  stopStreaming: () => {
    const state = get();
    if (state.isCompactingContext) return;
    if (state.activeConversationId && state.activeRunId) {
      trySendWSMessage({
        type: "run.stop",
        conversationId: state.activeConversationId,
        runId: state.activeRunId,
        clientCommandId: generateId(),
      });
    }
    set((state) => ({
      isStreaming: false,
      messages: state.messages.map((msg) =>
        msg.isStreaming ? { ...msg, isStreaming: false } : msg
      ),
    }));
  },

  clearMessages: () => {
    conversationLoadGeneration += 1;
    const activeConversationId = get().activeConversationId;
    if (activeConversationId) {
      trySendWSMessage({ type: "conversation.unsubscribe", conversationId: activeConversationId });
    }
    const draftSelection = resolveDraftProviderSelection(get().providerStatus);
    set({
      messages: [],
      queuedInputs: [],
      resourceReferences: [],
      savedName: null,
      activeConversationId: null,
      sidebarActiveConversationId: null,
      activeRunId: null,
      activePlan: null,
      plans: [],
      devPlanProgressPreview: null,
      workMode: "normal",
      canContinueConversation: false,
      isStreaming: false,
      isStartingConversation: false,
      isCompactingContext: false,
      lastContext: null,
      contextUsageDialog: null,
      ...draftSelection,
    });
  },

  fetchRecentConversations: async () => {
    if (!useAuthStore.getState().user) return;
    set((state) => ({
      isLoadingRecentConversations: state.recentConversations.length === 0,
    }));
    try {
      const conversations = await listConversations();
      set({ recentConversations: conversations, isLoadingRecentConversations: false });
    } catch {
      set({ isLoadingRecentConversations: false });
    }
  },

  fetchConversationFolders: async () => {
    if (!useAuthStore.getState().user) return;
    set((state) => ({
      isLoadingConversationFolders: state.conversationFolders.length === 0,
    }));
    try {
      const folders = await listConversationFolders();
      set({
        conversationFolders: sortConversationFolders(folders),
        isLoadingConversationFolders: false,
      });
    } catch {
      set({ isLoadingConversationFolders: false });
    }
  },

  createConversationFolder: async (input) => {
    const created = await createConversationFolder(input);
    set((state) => ({
      conversationFolders: sortConversationFolders([...state.conversationFolders, created]),
    }));
    return created;
  },

  updateConversationFolder: async (id, input) => {
    const previousFolders = get().conversationFolders;
    set((state) => ({
      conversationFolders: state.conversationFolders.map((folder) =>
        folder.id === id
          ? {
              ...folder,
              ...input,
              updatedAt: nowIso(),
            }
          : folder
      ),
    }));
    try {
      const updated = await updateConversationFolder(id, input);
      set((state) => ({
        conversationFolders: sortConversationFolders(
          state.conversationFolders.map((folder) => (folder.id === id ? updated : folder))
        ),
      }));
      return updated;
    } catch (error) {
      set({ conversationFolders: previousFolders });
      throw error;
    }
  },

  deleteConversationFolder: async (id) => {
    const previousFolders = get().conversationFolders;
    const previousConversations = get().recentConversations;
    set((state) => ({
      conversationFolders: state.conversationFolders.filter((folder) => folder.id !== id),
      recentConversations: state.recentConversations.map((conversation) =>
        conversation.folderId === id ? { ...conversation, folderId: null } : conversation
      ),
    }));
    try {
      await deleteConversationFolder(id);
    } catch (error) {
      set({ conversationFolders: previousFolders, recentConversations: previousConversations });
      throw error;
    }
  },

  reorderConversationFolders: async (folderIds) => {
    const previousFolders = get().conversationFolders;
    const orderById = new Map(folderIds.map((id, index) => [id, index]));
    const nextFolders = sortConversationFolders(
      previousFolders.map((folder) =>
        orderById.has(folder.id) ? { ...folder, sortOrder: orderById.get(folder.id)! } : folder
      )
    );
    set({ conversationFolders: nextFolders });
    try {
      const folders = await reorderConversationFolders(
        nextFolders.map((folder, index) => ({ id: folder.id, sortOrder: index }))
      );
      set({ conversationFolders: sortConversationFolders(folders) });
    } catch (error) {
      set({ conversationFolders: previousFolders });
      throw error;
    }
  },

  moveConversationsToFolder: async (conversationIds, folderId) => {
    const ids = new Set(conversationIds);
    const previousConversations = get().recentConversations;
    set((state) => ({
      recentConversations: state.recentConversations.map((conversation) =>
        ids.has(conversation.id) ? { ...conversation, folderId } : conversation
      ),
    }));
    try {
      await moveConversationsToFolder(conversationIds, folderId);
    } catch (error) {
      set({ recentConversations: previousConversations });
      throw error;
    }
  },

  loadConversation: async (conversationId: string) => {
    const loadGeneration = (conversationLoadGeneration += 1);
    try {
      const previousConversationId = get().activeConversationId;
      if (previousConversationId && previousConversationId !== conversationId) {
        trySendWSMessage({
          type: "conversation.unsubscribe",
          conversationId: previousConversationId,
        });
      }
      set({ sidebarActiveConversationId: conversationId, workMode: "normal" });
      const conversation = await getConversation(conversationId);
      if (loadGeneration !== conversationLoadGeneration) return;
      set({
        messages: applyConversationStatus(
          normalizeConversationMessages(conversation.messages, conversation.id),
          conversation.id,
          conversation.status,
          conversation.blockReason
        ),
        savedName: conversation.title,
        activeConversationId: conversation.id,
        sidebarActiveConversationId: conversation.id,
        activeRunId: null,
        activePlan: null,
        plans: [],
        workMode: "normal",
        isStreaming: false,
        canContinueConversation: false,
        isStartingConversation: false,
        isCompactingContext: false,
        lastContext: conversation.lastContext,
        selectedModel: conversation.model ?? get().selectedModel,
        selectedReasoningEffort:
          conversation.reasoningEffort ??
          resolveReasoningEffort(get().providerStatus, conversation.model ?? get().selectedModel),
      });
      trySendWSMessage({ type: "conversation.subscribe", conversationId });
    } catch {
      if (loadGeneration !== conversationLoadGeneration) return;
      const localMsg: AIMessage = {
        id: generateId(),
        role: "assistant",
        content: "Failed to load conversation.",
        createdAt: nowIso(),
        localOnly: true,
      };
      set({
        messages: [localMsg],
        queuedInputs: [],
        savedName: null,
        activeConversationId: null,
        sidebarActiveConversationId: null,
        activeRunId: null,
        activePlan: null,
        plans: [],
        workMode: "normal",
        isStreaming: false,
        canContinueConversation: false,
        isStartingConversation: false,
        isCompactingContext: false,
        lastContext: null,
        pendingApprovalToolCallId: null,
        pendingCredentialChallenge: null,
        pendingSetupInteraction: null,
      });
    }
  },

  deleteConversation: async (conversationId: string) => {
    try {
      await deleteConversation(conversationId);
      if (get().activeConversationId === conversationId) {
        trySendWSMessage({ type: "conversation.unsubscribe", conversationId });
      }
      set((state) => ({
        recentConversations: state.recentConversations.filter(
          (conversation) => conversation.id !== conversationId
        ),
        ...(state.activeConversationId === conversationId
          ? {
              messages: [],
              queuedInputs: [],
              resourceReferences: [],
              savedName: null,
              activeConversationId: null,
              sidebarActiveConversationId: null,
              activeRunId: null,
              activePlan: null,
              plans: [],
              canContinueConversation: false,
              isStartingConversation: false,
              isCompactingContext: false,
              lastContext: null,
              ...resolveDraftProviderSelection(state.providerStatus),
            }
          : {}),
      }));
    } catch {
      const localMsg: AIMessage = {
        id: generateId(),
        role: "assistant",
        content: "Failed to delete conversation.",
        createdAt: nowIso(),
        localOnly: true,
      };
      set((state) => ({ messages: [...state.messages, localMsg] }));
    }
  },

  renameConversation: async (conversationId: string, title: string) => {
    const conversation = await renameConversation(conversationId, title);
    set((state) => ({
      savedName:
        state.activeConversationId === conversationId ? conversation.title : state.savedName,
      recentConversations: sortConversationSummaries(
        state.recentConversations.map((item) =>
          item.id === conversationId
            ? {
                ...item,
                title: conversation.title,
                updatedAt: conversation.updatedAt,
                lastUserMessageAt: conversation.lastUserMessageAt,
                status: conversation.status,
                blockReason: conversation.blockReason,
                activeRunStatus: conversation.activeRunStatus,
              }
            : item
        )
      ),
    }));
  },

  rollbackToMessage: async (messageId: string) => {
    const state = get();
    if (!state.activeConversationId || state.isCompactingContext) return null;
    const existing = state.messages.find((message) => message.id === messageId);
    if (!existing || existing.role !== "user") return null;

    const activeRunId = state.activeRunId;
    const result = activeRunId
      ? await rollbackConversationToMessage(state.activeConversationId, messageId, activeRunId)
      : await rollbackConversationToMessage(state.activeConversationId, messageId);
    const messages = normalizeConversationMessages(
      result.conversation.messages,
      result.conversation.id
    );
    set((state) => ({
      messages,
      savedName: result.conversation.title,
      activeConversationId: result.conversation.id,
      sidebarActiveConversationId: result.conversation.id,
      activeRunId: null,
      isCompactingContext: false,
      lastContext: result.conversation.lastContext,
      selectedModel: result.conversation.model ?? state.selectedModel,
      selectedReasoningEffort:
        result.conversation.reasoningEffort ??
        resolveReasoningEffort(
          state.providerStatus,
          result.conversation.model ?? state.selectedModel
        ),
      pendingApprovalToolCallId: null,
      pendingCredentialChallenge: null,
      pendingSetupInteraction: null,
      isStreaming: false,
      isStartingConversation: false,
      recentConversations: sortConversationSummaries(
        state.recentConversations.map((item) =>
          item.id === result.conversation.id
            ? {
                ...item,
                title: result.conversation.title,
                updatedAt: result.conversation.updatedAt,
                lastUserMessageAt: result.conversation.lastUserMessageAt,
                folderId: result.conversation.folderId,
                messageCount: result.conversation.messages.length,
                status: result.conversation.status,
                blockReason: result.conversation.blockReason,
                activeRunStatus: result.conversation.activeRunStatus,
              }
            : item
        )
      ),
    }));
    trySendWSMessage({ type: "conversation.sync", conversationId: result.conversation.id });
    return result.message;
  },

  retryMessage: async (messageId: string) => {
    const state = get();
    if (state.isStreaming || state.isCompactingContext) return;
    const message = await get().rollbackToMessage(messageId);
    if (!message) return;
    get().sendMessage(message.content, get().lastContext ?? undefined, message.attachments ?? []);
  },

  setEnabled: (enabled: boolean) => {
    set({ isEnabled: enabled });
  },

  setProviderStatus: (status: AIProviderStatus) => {
    set((state) => {
      if (status.providerType === "openai_compatible") {
        const storedReasoningEffort = loadStoredAIReasoningEffort(status.defaultModel);
        const currentReasoningEffort = (status.reasoningEfforts ?? []).includes(
          state.selectedReasoningEffort ?? ""
        )
          ? state.selectedReasoningEffort
          : null;
        return {
          providerStatus: status,
          selectedModel: null,
          selectedReasoningEffort: status.allowUserReasoningEffortSelection
            ? currentReasoningEffort ||
              ((status.reasoningEfforts ?? []).includes(storedReasoningEffort ?? "")
                ? storedReasoningEffort
                : status.defaultReasoningEffort)
            : null,
          isEnabled: status.enabled,
        };
      }
      const selectable = status.providerType === "gateway_inference" && status.models.length > 0;
      const hasLoadedConversation =
        Boolean(state.activeConversationId) && state.messages.length > 0;
      const currentAllowed =
        selectable &&
        (status.allowUserModelSelection || hasLoadedConversation) &&
        status.models.some((model) => model.id === state.selectedModel);
      const selectedModel = selectable
        ? currentAllowed
          ? state.selectedModel
          : status.defaultModel || status.models[0]?.id || null
        : null;
      const selectedModelOption = status.models.find((model) => model.id === selectedModel);
      const storedReasoningEffort = loadStoredAIReasoningEffort(selectedModel);
      const selectedReasoningEffort =
        hasLoadedConversation && currentAllowed
          ? state.selectedReasoningEffort
          : selectedModelOption?.reasoningEfforts.includes(state.selectedReasoningEffort ?? "")
            ? state.selectedReasoningEffort
            : selectedModelOption?.reasoningEfforts.includes(storedReasoningEffort ?? "")
              ? storedReasoningEffort
              : selectedModelOption?.defaultReasoningEffort ||
                selectedModelOption?.reasoningEfforts[0] ||
                null;
      if (!hasLoadedConversation) storeAIModel(selectedModel);
      return {
        providerStatus: status,
        selectedModel,
        selectedReasoningEffort,
        isEnabled: status.enabled,
      };
    });
  },

  refreshProviderStatus: async () => {
    const status = await api.getAIStatus();
    get().setProviderStatus(status);
  },

  setSelectedModel: async (model: string) => {
    const state = get();
    const status = state.providerStatus;
    if (
      status?.providerType !== "gateway_inference" ||
      !status.allowUserModelSelection ||
      !status.models.some((option) => option.id === model)
    ) {
      return;
    }
    storeAIModel(model);
    const option = status.models.find((candidate) => candidate.id === model);
    const storedReasoningEffort = loadStoredAIReasoningEffort(model);
    const selectedReasoningEffort = option?.reasoningEfforts.includes(storedReasoningEffort ?? "")
      ? storedReasoningEffort
      : option?.defaultReasoningEffort || option?.reasoningEfforts[0] || null;
    const previousModel = state.selectedModel;
    const previousReasoningEffort = state.selectedReasoningEffort;
    set({ selectedModel: model, selectedReasoningEffort });
    if (!state.activeConversationId || state.messages.length === 0) return;

    try {
      const conversation = await updateConversationProvider(state.activeConversationId, {
        model,
        reasoningEffort: selectedReasoningEffort,
      });
      if (get().activeConversationId !== conversation.id) return;
      set({
        messages: applyConversationStatus(
          normalizeConversationMessages(conversation.messages, conversation.id),
          conversation.id,
          conversation.status,
          conversation.blockReason
        ),
        selectedModel: conversation.model ?? model,
        selectedReasoningEffort: conversation.reasoningEffort ?? selectedReasoningEffort,
      });
    } catch (error) {
      if (get().activeConversationId === state.activeConversationId) {
        set({
          selectedModel: previousModel,
          selectedReasoningEffort: previousReasoningEffort,
        });
      }
      storeAIModel(previousModel);
      throw error;
    }
  },

  setSelectedReasoningEffort: async (effort: string) => {
    const state = get();
    const { providerStatus, selectedModel } = state;
    if (providerStatus?.providerType === "openai_compatible") {
      if (
        !providerStatus.allowUserReasoningEffortSelection ||
        !(providerStatus.reasoningEfforts ?? []).includes(effort)
      ) {
        return;
      }
      storeAIReasoningEffort(providerStatus.defaultModel, effort);
      set({ selectedReasoningEffort: effort });
      if (!state.activeConversationId || state.messages.length === 0) return;
      try {
        const conversation = await updateConversationProvider(state.activeConversationId, {
          model: providerStatus.defaultModel,
          reasoningEffort: effort,
        });
        if (get().activeConversationId !== conversation.id) return;
        set({
          selectedModel: null,
          selectedReasoningEffort: conversation.reasoningEffort ?? effort,
        });
      } catch (error) {
        if (get().activeConversationId === state.activeConversationId) {
          set({ selectedReasoningEffort: state.selectedReasoningEffort });
        }
        storeAIReasoningEffort(providerStatus.defaultModel, state.selectedReasoningEffort);
        throw error;
      }
      return;
    }
    const option = providerStatus?.models.find((model) => model.id === selectedModel);
    if (
      providerStatus?.providerType !== "gateway_inference" ||
      !selectedModel ||
      !option?.reasoningEfforts.includes(effort)
    ) {
      return;
    }
    storeAIReasoningEffort(selectedModel, effort);
    set({ selectedReasoningEffort: effort });
    if (!state.activeConversationId || state.messages.length === 0) return;

    try {
      const conversation = await updateConversationProvider(state.activeConversationId, {
        model: selectedModel,
        reasoningEffort: effort,
      });
      if (get().activeConversationId !== conversation.id) return;
      set({
        selectedModel: conversation.model ?? selectedModel,
        selectedReasoningEffort: conversation.reasoningEffort ?? effort,
      });
    } catch (error) {
      if (get().activeConversationId === state.activeConversationId) {
        set({ selectedReasoningEffort: state.selectedReasoningEffort });
      }
      storeAIReasoningEffort(selectedModel, state.selectedReasoningEffort);
      throw error;
    }
  },

  setMessages: (messages: AIMessage[]) => {
    set({ messages });
  },

  closeContextUsageDialog: () => {
    set({ contextUsageDialog: null });
  },

  handleSlashCommand: async (input: string): Promise<boolean> => {
    if (get().isStreaming) return true;
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    if (cmd === "/clear" || cmd === "/new") {
      const activeConversationId = get().activeConversationId;
      if (activeConversationId) {
        trySendWSMessage({
          type: "conversation.unsubscribe",
          conversationId: activeConversationId,
        });
      }
      const draftSelection = resolveDraftProviderSelection(get().providerStatus);
      set({
        messages: [],
        queuedInputs: [],
        resourceReferences: [],
        savedName: null,
        activeConversationId: null,
        sidebarActiveConversationId: null,
        activeRunId: null,
        activePlan: null,
        plans: [],
        workMode: "normal",
        isStreaming: false,
        isStartingConversation: false,
        isCompactingContext: false,
        lastContext: null,
        contextUsageDialog: null,
        ...draftSelection,
      });
      return true;
    }

    if (cmd === "/compact") {
      const {
        activeConversationId,
        lastContext,
        providerStatus,
        selectedModel,
        selectedReasoningEffort,
      } = get();
      if (!activeConversationId) {
        set((state) => ({
          messages: appendLocalAssistantError(
            state.messages,
            "Open a saved conversation before compacting context."
          ),
        }));
        return true;
      }

      const clientCommandId = generateId();
      set({
        isStreaming: true,
        activeRunId: null,
        isCompactingContext: true,
        pendingApprovalToolCallId: null,
        pendingCredentialChallenge: null,
        pendingSetupInteraction: null,
      });
      try {
        sendWSMessage({
          type: "conversation.compact",
          conversationId: activeConversationId,
          clientCommandId,
          context: lastContext ?? undefined,
          ...(providerStatus?.providerType === "gateway_inference" && selectedModel
            ? { model: selectedModel }
            : {}),
          ...(canSendSelectedReasoningEffort(providerStatus) && selectedReasoningEffort
            ? { reasoningEffort: selectedReasoningEffort }
            : {}),
        });
      } catch (error) {
        set((state) => ({
          isStreaming: false,
          isCompactingContext: false,
          messages: appendLocalAssistantError(
            state.messages,
            `**Error:** ${error instanceof Error ? error.message : "Failed to compact context"}`
          ),
        }));
      }
      return true;
    }

    if (cmd === "/context") {
      const {
        activeConversationId,
        lastContext,
        messages,
        providerStatus,
        selectedModel,
        selectedReasoningEffort,
      } = get();
      const usage = await getAIContextUsage(
        messages,
        lastContext ?? undefined,
        activeConversationId,
        providerStatus?.providerType === "gateway_inference" ? selectedModel : undefined,
        canSendSelectedReasoningEffort(providerStatus) ? selectedReasoningEffort : undefined
      );
      set({ contextUsageDialog: usage });
      return true;
    }

    return false;
  },
}));

export function resetAIStateForAuthChange() {
  wsClient?.disconnect();
  wsClient = null;
  for (const buffer of assistantDeltaBuffers.values()) clearTimeout(buffer.timer);
  assistantDeltaBuffers.clear();
  conversationLoadGeneration += 1;
  assistantDraftVersions.clear();
  completedAssistantCommentVersions.clear();
  terminalAssistantRuns.clear();
  appliedConversationRevisions.clear();
  pendingToolCommands.clear();
  pendingInputCommands.clear();
  observedPlanStatuses.clear();
  cancelledPlanTombstones.clear();
  pendingPlanCancellationCommands.clear();
  pendingSetupCommands.clear();
  contextEstimateCache = null;
  contextEstimateRequests.clear();
  useAIStore.setState({
    messages: [],
    queuedInputs: [],
    resourceReferences: [],
    recentConversations: [],
    conversationFolders: [],
    isLoadingRecentConversations: false,
    isLoadingConversationFolders: false,
    isStreaming: false,
    isStartingConversation: false,
    isConnected: false,
    isConnecting: false,
    connectionError: null,
    retryAfter: null,
    savedName: null,
    activeConversationId: null,
    sidebarActiveConversationId: null,
    activeRunId: null,
    activePlan: null,
    plans: [],
    devPlanProgressPreview: null,
    dismissedPlanDecisionKey: null,
    workMode: "normal",
    canContinueConversation: false,
    isCompactingContext: false,
    lastContext: null,
    pendingApprovalToolCallId: null,
    pendingCredentialChallenge: null,
    pendingSetupInteraction: null,
    providerStatus: null,
    selectedModel: loadStoredAIModel(),
    selectedReasoningEffort: loadStoredAIReasoningEffort(loadStoredAIModel()),
    contextUsageDialog: null,
  });
}

function handleWSMessage(
  msg: WSServerMessage,
  set: (partial: Partial<AIState> | ((state: AIState) => Partial<AIState>)) => void,
  get: () => AIState
) {
  switch (msg.type) {
    case "command.ack":
      {
        if (msg.clientCommandId) pendingSetupCommands.delete(msg.clientCommandId);
        if (msg.clientCommandId) pendingInputCommands.delete(msg.clientCommandId);
        if (msg.clientCommandId && msg.commandType === "plan.cancel") {
          pendingPlanCancellationCommands.delete(msg.clientCommandId);
        }
        const pending = msg.clientCommandId
          ? pendingToolCommands.get(msg.clientCommandId)
          : undefined;
        if (msg.clientCommandId) pendingToolCommands.delete(msg.clientCommandId);
        if (pending?.decision === "approval") {
          set((state) => ({
            messages: updateToolCallById(state.messages, pending.toolCallId, (tc) => ({
              ...tc,
              approvalDecisionPending: false,
              status: pending.approvalDecision === "rejected" ? "rejected" : "running",
            })),
            pendingApprovalToolCallId:
              state.pendingApprovalToolCallId === pending.toolCallId
                ? null
                : state.pendingApprovalToolCallId,
          }));
        }
      }
      set((state) => {
        const selectsConversation =
          msg.commandType === "conversation.send_message" ||
          msg.commandType === "conversation.start_scenario";
        const matchesCurrentConversation =
          !!msg.conversationId && state.activeConversationId === msg.conversationId;
        return {
          ...(selectsConversation && msg.conversationId
            ? {
                activeConversationId: msg.conversationId,
                sidebarActiveConversationId: msg.conversationId,
              }
            : {}),
          ...(msg.runId && (selectsConversation || matchesCurrentConversation)
            ? { activeRunId: msg.runId }
            : {}),
          ...(msg.runId && msg.clientCommandId && selectsConversation
            ? {
                messages: state.messages.map((message) =>
                  message.id === startingAssistantMessageId(msg.clientCommandId!)
                    ? {
                        ...message,
                        id: `${msg.runId}:runtime`,
                        runId: msg.runId,
                        isStreaming: true,
                      }
                    : message
                ),
              }
            : {}),
        };
      });
      break;

    case "command.error":
      {
        const failedSetup = msg.clientCommandId
          ? pendingSetupCommands.get(msg.clientCommandId)
          : undefined;
        if (failedSetup) {
          pendingSetupCommands.delete(msg.clientCommandId!);
          set({ pendingSetupInteraction: failedSetup });
          toast.error(msg.message);
          break;
        }
        const cancelledPlan = msg.clientCommandId
          ? pendingPlanCancellationCommands.get(msg.clientCommandId)
          : undefined;
        if (cancelledPlan && msg.commandType === "plan.cancel") {
          pendingPlanCancellationCommands.delete(msg.clientCommandId!);
          const tombstone = cancelledPlanTombstones.get(cancelledPlan.conversationId);
          if (tombstone?.clientCommandId === msg.clientCommandId) {
            cancelledPlanTombstones.delete(cancelledPlan.conversationId);
          }
          set((state) => ({
            activePlan:
              state.activeConversationId === cancelledPlan.conversationId
                ? cancelledPlan.plan
                : state.activePlan,
            plans: upsertTimelinePlan(state.plans, cancelledPlan.plan),
          }));
          toast.error(msg.message);
          break;
        }
        const pendingInput = msg.clientCommandId
          ? pendingInputCommands.get(msg.clientCommandId)
          : undefined;
        if (pendingInput) {
          if (msg.clientCommandId) pendingInputCommands.delete(msg.clientCommandId);
          set((state) => {
            if (pendingInput.kind === "queue") {
              return {
                queuedInputs: state.queuedInputs.filter(
                  (input) => input.id !== pendingInput.input.id
                ),
              };
            }
            return {
              queuedInputs: state.queuedInputs.some((input) => input.id === pendingInput.input.id)
                ? state.queuedInputs
                : [...state.queuedInputs, pendingInput.input],
              messages:
                pendingInput.kind === "steer"
                  ? state.messages.filter(
                      (message) => message.id !== `steer:${pendingInput.input.id}`
                    )
                  : state.messages,
            };
          });
          break;
        }
        const pending = msg.clientCommandId
          ? pendingToolCommands.get(msg.clientCommandId)
          : undefined;
        if (pending) {
          if (msg.clientCommandId) pendingToolCommands.delete(msg.clientCommandId);
          set((state) => ({
            isStreaming: false,
            isCompactingContext: false,
            messages: updateToolCallById(state.messages, pending.toolCallId, (tc) => ({
              ...tc,
              status: pending.previousStatus,
              approvalDecisionPending: false,
              result: pending.previousResult,
              error: msg.message,
            })),
            pendingApprovalToolCallId: pending.toolCallId,
          }));
          break;
        }
      }
      set((state) => ({
        isStreaming: false,
        isStartingConversation: false,
        isCompactingContext: false,
        messages: appendLocalAssistantError(
          removeStartingAssistantMessage(state.messages, msg.clientCommandId),
          `**Error:** ${msg.message}`
        ),
        ...(msg.commandType === "conversation.continue" ? { canContinueConversation: true } : {}),
      }));
      break;

    case "conversation.snapshot": {
      const revision = typeof msg.snapshot.revision === "number" ? msg.snapshot.revision : null;
      if (!acceptConversationRevision(msg.conversationId, revision ?? undefined)) return;
      set((state) => ({
        recentConversations: patchRecentConversationFromSnapshot(
          state.recentConversations,
          msg.snapshot
        ),
      }));
      if (get().activeConversationId !== msg.conversationId) return;
      const previousRunId = get().activeRunId;
      const snapshotRun = msg.snapshot.runtime.activeRun;
      if (!snapshotRun) {
        const completedRunIds = new Set(
          [...assistantDeltaBuffers.entries()]
            .filter(([, buffer]) => buffer.message.conversationId === msg.conversationId)
            .map(([runId]) => runId)
        );
        if (previousRunId) completedRunIds.add(previousRunId);
        for (const runId of completedRunIds) {
          flushAssistantDelta(runId, set, get);
          terminalAssistantRuns.add(runId);
        }
      } else if (snapshotRun && isActiveRunStatus(snapshotRun.status)) {
        terminalAssistantRuns.delete(snapshotRun.id);
      }
      set((state) => {
        const projection = projectConversationSnapshot(
          msg.snapshot,
          state.messages,
          state.pendingCredentialChallenge
        );
        const tombstone = cancelledPlanTombstones.get(msg.conversationId);
        const snapshotPlan = msg.snapshot.runtime.activePlan;
        if (tombstone) {
          if (!snapshotPlan || snapshotPlan.id !== tombstone.planId) {
            cancelledPlanTombstones.delete(msg.conversationId);
          } else if (snapshotPlan.status === "cancelled") {
            cancelledPlanTombstones.delete(msg.conversationId);
            projection.activePlan = null;
          } else {
            projection.activePlan = null;
            projection.plans = (projection.plans ?? []).map((plan) =>
              plan.id === tombstone.planId
                ? { ...plan, status: "cancelled", updatedAt: nowIso() }
                : plan
            );
          }
        }
        return { ...projection, isStartingConversation: false };
      });
      break;
    }

    case "plan.status_changed": {
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      const tombstone = cancelledPlanTombstones.get(msg.conversationId);
      if (tombstone?.planId === msg.plan.id && msg.plan.status !== "cancelled") return;
      if (tombstone?.planId === msg.plan.id) {
        cancelledPlanTombstones.delete(msg.conversationId);
      }
      const previousStatus = observedPlanStatuses.get(msg.conversationId);
      observedPlanStatuses.set(msg.conversationId, msg.plan.status);
      set((state) => ({
        recentConversations: state.recentConversations.map((conversation) =>
          conversation.id === msg.conversationId
            ? { ...conversation, planStatus: msg.plan.status }
            : conversation
        ),
        ...(state.activeConversationId === msg.conversationId
          ? {
              activePlan: msg.plan.status === "cancelled" ? null : msg.plan,
              plans: upsertTimelinePlan(state.plans, msg.plan),
            }
          : {}),
      }));
      if (previousStatus && previousStatus !== msg.plan.status) {
        const title = msg.plan.title || "Work Session plan";
        if (msg.plan.status === "awaiting_decision") toast.info(`${title} is ready to review`);
        if (msg.plan.status === "paused") toast.warning(`${title} is paused`);
        if (msg.plan.status === "completed") toast.success(`${title} is complete`);
      }
      break;
    }

    case "client.action":
      if (get().activeConversationId !== msg.conversationId) return;
      if (get().activeRunId && get().activeRunId !== msg.runId) return;
      applyAssistantResourcePinAction({ clientAction: msg.action });
      break;

    case "assistant.delta":
      if (get().activeConversationId !== msg.conversationId) return;
      completedAssistantCommentVersions.delete(msg.runId);
      queueAssistantDelta(msg, "assistant", set, get);
      break;

    case "assistant.comment_delta":
      if (get().activeConversationId !== msg.conversationId) return;
      completedAssistantCommentVersions.delete(msg.runId);
      queueAssistantDelta(msg, "comment", set, get);
      break;

    case "assistant.comment_done":
      if (get().activeConversationId !== msg.conversationId) return;
      if (terminalAssistantRuns.has(msg.runId)) return;
      flushAssistantDelta(msg.runId, set, get);
      completedAssistantCommentVersions.set(msg.runId, assistantDraftVersions.get(msg.runId) ?? 0);
      set((state) => ({
        activeRunId: msg.runId,
        isStreaming: true,
        messages: applyAssistantCommentDoneToMessages(state.messages, msg),
      }));
      break;

    case "credential.required":
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      if (get().activeConversationId !== msg.conversationId) return;
      set((state) => ({
        activeRunId: msg.runId,
        isStreaming: true,
        isCompactingContext: false,
        pendingCredentialChallenge: msg.challenge,
        recentConversations: patchRecentConversationRunStatus(
          state.recentConversations,
          msg.conversationId,
          "waiting_for_credential"
        ),
      }));
      break;

    case "run.status_changed":
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      if (!isActiveRunStatus(msg.run?.status) && msg.run?.id) {
        flushAssistantDelta(msg.run.id, set, get);
        terminalAssistantRuns.add(msg.run.id);
      } else if (msg.run?.id) {
        terminalAssistantRuns.delete(msg.run.id);
      }
      set((state) => ({
        recentConversations: patchRecentConversationRunStatus(
          state.recentConversations,
          msg.conversationId,
          msg.run?.status ?? null
        ),
        ...(state.activeConversationId === msg.conversationId
          ? {
              activeRunId: msg.run?.id ?? null,
              isStreaming: isActiveRunStatus(msg.run?.status),
              isCompactingContext: Boolean(
                msg.run && msg.run.activeMessageId === null && isActiveRunStatus(msg.run.status)
              ),
            }
          : {}),
      }));
      break;

    case "stores.invalidated":
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      for (const storeName of msg.stores) invalidateToolStore(storeName);
      break;

    case "question.answered":
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      if (get().activeConversationId !== msg.conversationId) return;
      set((state) => ({
        activeRunId: msg.runId,
        isStreaming: true,
        pendingApprovalToolCallId: null,
        messages: ensureActiveRuntimePlaceholder(
          updateToolCallById(state.messages, msg.question.toolCallId, (tc) => ({
            ...tc,
            status: "completed",
            result: { answer: msg.question.answer ?? tc.result },
            error: undefined,
          })),
          msg.runId
        ),
      }));
      break;

    case "credential.updated":
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      if (get().activeConversationId !== msg.conversationId) return;
      set((state) => ({
        activeRunId: msg.runId,
        isStreaming: true,
        pendingCredentialChallenge:
          state.pendingCredentialChallenge?.id === msg.challenge.id
            ? null
            : state.pendingCredentialChallenge,
      }));
      break;

    case "approval.updated":
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      for (const [clientCommandId, pending] of pendingToolCommands) {
        if (pending.toolCallId === msg.approval.toolCallId) {
          pendingToolCommands.delete(clientCommandId);
        }
      }
      if (get().activeConversationId !== msg.conversationId) return;
      set((state) => ({
        activeRunId: msg.runId,
        messages: updateToolCallById(state.messages, msg.approval.toolCallId, () =>
          runtimeToolCallToUI(msg.approval)
        ),
        pendingApprovalToolCallId:
          state.pendingApprovalToolCallId === msg.approval.toolCallId
            ? null
            : state.pendingApprovalToolCallId,
      }));
      break;
  }
}

function projectConversationSnapshot(
  snapshot: AIConversationRuntimeSnapshot,
  currentMessages: AIMessage[] = [],
  currentCredentialChallenge: AICredentialChallenge | null = null
): Partial<AIState> {
  const activeRunId = snapshot.runtime.activeRun?.id ?? null;
  const pendingCredentialChallenge =
    snapshot.runtime.pendingCredentialChallenge ??
    (currentCredentialChallenge &&
    activeRunId === currentCredentialChallenge.runId &&
    isActiveRunStatus(snapshot.runtime.activeRun?.status)
      ? currentCredentialChallenge
      : null);
  const snapshotDraftVersion = snapshot.runtime.assistantDraftVersion;
  const currentDraftVersion = activeRunId ? (assistantDraftVersions.get(activeRunId) ?? -1) : -1;
  const completedCommentVersion = activeRunId
    ? (completedAssistantCommentVersions.get(activeRunId) ?? -1)
    : -1;
  const snapshotDraftIsStale = Boolean(
    activeRunId &&
      typeof snapshotDraftVersion === "number" &&
      (snapshotDraftVersion < currentDraftVersion ||
        snapshotDraftVersion <= completedCommentVersion)
  );

  if (activeRunId && typeof snapshotDraftVersion === "number" && !snapshotDraftIsStale) {
    assistantDraftVersions.set(activeRunId, snapshotDraftVersion);
  }
  const runtimeToolCalls = snapshot.runtime.toolCalls
    .filter((toolCall) => toolCall.toolName !== "send_comment")
    .map(runtimeToolCallToUI);
  const runtimeToolCallsById = new Map(runtimeToolCalls.map((toolCall) => [toolCall.id, toolCall]));
  const pendingQuestions =
    snapshot.runtime.pendingQuestions.length > 0
      ? snapshot.runtime.pendingQuestions
      : snapshot.runtime.pendingQuestion
        ? [snapshot.runtime.pendingQuestion]
        : [];
  const pendingQuestionToolCalls = pendingQuestions.map((question) =>
    pendingQuestionToToolCall(question, runtimeToolCallsById.get(question.toolCallId))
  );
  const pendingInputs = snapshot.runtime.pendingInputs ?? [];
  const snapshotMessages = reconcileOptimisticMessages(
    normalizeSnapshotMessages(snapshot),
    currentMessages,
    snapshot.runtime.activeRun?.id ?? null,
    snapshot.runtime.activeRun?.clientCommandId ?? null
  );
  const attachedMessages = preserveFreshRuntimeDraft(
    attachRuntimeToolCallsToMessages(
      appendPendingSteerMessages(snapshotMessages, pendingInputs),
      [...runtimeToolCalls, ...pendingQuestionToolCalls],
      Boolean(snapshot.runtime.activeRun),
      snapshot.runtime.activeRun?.id ?? null
    ),
    currentMessages,
    snapshotDraftIsStale ? activeRunId : null
  );
  const messages = applyConversationStatus(
    clearActiveToolBoundaryStreamingWhenTextStarted(attachedMessages, activeRunId),
    snapshot.conversation.id,
    snapshot.conversation.status,
    snapshot.conversation.blockReason
  );

  return {
    messages,
    queuedInputs: pendingInputs.filter((input) => input.mode === "queued"),
    resourceReferences: snapshot.resourceReferences ?? [],
    savedName: snapshot.conversation.title,
    activeConversationId: snapshot.conversation.id,
    sidebarActiveConversationId: snapshot.conversation.id,
    activeRunId: snapshot.runtime.activeRun?.id ?? null,
    activePlan: snapshot.runtime.activePlan ?? null,
    plans:
      snapshot.runtime.plans ?? (snapshot.runtime.activePlan ? [snapshot.runtime.activePlan] : []),
    canContinueConversation: snapshot.runtime.canContinue === true,
    isCompactingContext: Boolean(
      snapshot.runtime.activeRun &&
        snapshot.runtime.activeRun.activeMessageId === null &&
        isActiveRunStatus(snapshot.runtime.activeRun.status)
    ),
    lastContext: snapshot.conversation.lastContext,
    ...(typeof snapshot.conversation.model === "string"
      ? {
          selectedModel: snapshot.conversation.model,
          selectedReasoningEffort: snapshot.conversation.reasoningEffort ?? null,
        }
      : {}),
    pendingApprovalToolCallId:
      snapshot.runtime.pendingApprovals[0]?.toolCallId ?? pendingQuestions[0]?.toolCallId ?? null,
    pendingCredentialChallenge,
    pendingSetupInteraction: snapshot.runtime.pendingSetupInteraction ?? null,
    isStreaming:
      Boolean(pendingCredentialChallenge) || isActiveRunStatus(snapshot.runtime.activeRun?.status),
    isStartingConversation: false,
  };
}

function reconcileOptimisticMessages(
  snapshotMessages: AIMessage[],
  currentMessages: AIMessage[],
  activeRunId: string | null,
  activeClientCommandId: string | null
): AIMessage[] {
  const currentUsersByCommand = new Map(
    currentMessages.flatMap((message) =>
      message.role === "user" && message.clientCommandId
        ? [[message.clientCommandId, message] as const]
        : []
    )
  );
  const stableSnapshotMessages = snapshotMessages.map((message) => {
    if (message.role !== "user" || !message.clientCommandId) return message;
    const current = currentUsersByCommand.get(message.clientCommandId);
    return current ? { ...message, id: current.id } : message;
  });
  const persistedCommands = new Set(
    stableSnapshotMessages.flatMap((message) =>
      message.clientCommandId ? [message.clientCommandId] : []
    )
  );
  const missingOptimisticUsers = currentMessages.filter(
    (message) =>
      message.role === "user" &&
      message.localOnly &&
      message.clientCommandId &&
      !persistedCommands.has(message.clientCommandId)
  );
  const next = [...stableSnapshotMessages, ...missingOptimisticUsers];
  if (!activeRunId || !activeClientCommandId) return next;
  const optimisticAssistant = currentMessages.find(
    (message) => message.id === startingAssistantMessageId(activeClientCommandId)
  );
  if (!optimisticAssistant || next.some((message) => message.id === `${activeRunId}:runtime`)) {
    return next;
  }
  return [
    ...next,
    {
      ...optimisticAssistant,
      id: `${activeRunId}:runtime`,
      runId: activeRunId,
      isStreaming: true,
    },
  ];
}

function preserveFreshRuntimeDraft(
  snapshotMessages: AIMessage[],
  currentMessages: AIMessage[],
  activeRunId: string | null
): AIMessage[] {
  if (!activeRunId) return snapshotMessages;
  const currentIndex = findActiveRuntimeAssistantIndex(currentMessages, activeRunId);
  const nextMessages = [...snapshotMessages];
  if (currentIndex !== -1) {
    const snapshotIndex = findActiveRuntimeAssistantIndex(snapshotMessages, activeRunId);
    if (snapshotIndex !== -1) {
      const currentDraft = currentMessages[currentIndex];
      nextMessages[snapshotIndex] = {
        ...nextMessages[snapshotIndex],
        content: currentDraft.content,
        isStreaming: currentDraft.isStreaming,
        streamingChunk: currentDraft.streamingChunk,
      };
    }
  }

  const currentCommentIndex = findActiveCommentIndex(currentMessages, activeRunId);
  if (
    currentCommentIndex !== -1 &&
    !nextMessages.some((message) => message.id === currentMessages[currentCommentIndex].id)
  ) {
    nextMessages.push(currentMessages[currentCommentIndex]);
  }
  return sortMessagesBySequence(nextMessages);
}

function queueAssistantDelta(
  message: Extract<WSServerMessage, { type: "assistant.delta" | "assistant.comment_delta" }>,
  kind: "assistant" | "comment",
  set: (partial: Partial<AIState> | ((state: AIState) => Partial<AIState>)) => void,
  get: () => AIState
): void {
  if (terminalAssistantRuns.has(message.runId)) return;
  const buffered = assistantDeltaBuffers.get(message.runId);
  const appliedVersion = assistantDraftVersions.get(message.runId) ?? 0;
  if (message.version <= Math.max(appliedVersion, buffered?.version ?? 0)) return;
  if (buffered && buffered.kind !== kind) flushAssistantDelta(message.runId, set, get);
  const active = assistantDeltaBuffers.get(message.runId);
  const timer =
    active?.timer ??
    setTimeout(() => flushAssistantDelta(message.runId, set, get), ASSISTANT_DELTA_BATCH_MS);
  assistantDeltaBuffers.set(message.runId, {
    kind,
    content: `${active?.content ?? ""}${message.content}`,
    version: message.version,
    message,
    timer,
  });
  const pendingContent = assistantDeltaBuffers.get(message.runId)?.content ?? "";
  if (pendingContent.trim().split(/\s+/u).filter(Boolean).length >= ASSISTANT_DELTA_BATCH_WORDS) {
    flushAssistantDelta(message.runId, set, get);
  }
}

function flushAssistantDelta(
  runId: string,
  set: (partial: Partial<AIState> | ((state: AIState) => Partial<AIState>)) => void,
  get: () => AIState
): void {
  const buffered = assistantDeltaBuffers.get(runId);
  if (!buffered) return;
  clearTimeout(buffered.timer);
  assistantDeltaBuffers.delete(runId);
  if (get().activeConversationId !== buffered.message.conversationId) return;
  const delta = { ...buffered.message, content: buffered.content, version: buffered.version };
  set((state) => ({
    activeRunId: runId,
    isStreaming: true,
    isStartingConversation: false,
    isCompactingContext: false,
    messages:
      buffered.kind === "assistant"
        ? applyAssistantDeltaToMessages(
            state.messages,
            delta as Extract<WSServerMessage, { type: "assistant.delta" }>
          )
        : applyAssistantCommentDeltaToMessages(
            state.messages,
            delta as Extract<WSServerMessage, { type: "assistant.comment_delta" }>
          ),
    recentConversations: patchRecentConversationRunStatus(
      state.recentConversations,
      buffered.message.conversationId,
      "running"
    ),
  }));
}

function applyAssistantDeltaToMessages(
  messages: AIMessage[],
  delta: Extract<WSServerMessage, { type: "assistant.delta" }>
): AIMessage[] {
  const previousVersion = assistantDraftVersions.get(delta.runId) ?? 0;
  if (delta.version <= previousVersion) return messages;
  assistantDraftVersions.set(delta.runId, delta.version);

  const nextMessages = [...messages];
  let targetIndex = findActiveRuntimeAssistantIndex(nextMessages, delta.runId);
  if (targetIndex === -1) {
    targetIndex = nextMessages.length;
    nextMessages.push({
      id: `${delta.runId}:runtime`,
      role: "assistant",
      content: "",
      sequence: nextMessageSequence(nextMessages),
      createdAt: nowIso(),
      isStreaming: true,
    });
  }

  const current = nextMessages[targetIndex];
  nextMessages[targetIndex] = {
    ...current,
    content: `${current.content}${delta.content}`,
    streamingChunk: delta.content,
    isStreaming: true,
  };
  return sortMessagesBySequence(
    clearActiveToolBoundaryStreamingWhenTextStarted(nextMessages, delta.runId)
  );
}

function applyAssistantCommentDeltaToMessages(
  messages: AIMessage[],
  delta: Extract<WSServerMessage, { type: "assistant.comment_delta" }>
): AIMessage[] {
  const previousVersion = assistantDraftVersions.get(delta.runId) ?? 0;
  if (delta.version <= previousVersion) return messages;
  assistantDraftVersions.set(delta.runId, delta.version);

  const nextMessages = [...messages];
  let targetIndex = findLastIndex(
    nextMessages,
    (message) =>
      message.role === "assistant" &&
      message.id.startsWith(`${delta.runId}:comment:`) &&
      Boolean(message.isStreaming)
  );
  if (targetIndex === -1) {
    const placeholderIndex = nextMessages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.id === `${delta.runId}:runtime` &&
        !message.content.trim() &&
        !message.toolCalls?.length
    );
    if (placeholderIndex === -1) {
      targetIndex = nextMessages.length;
      nextMessages.push({
        id: `${delta.runId}:comment:${delta.version}`,
        role: "assistant",
        content: "",
        sequence: nextMessageSequence(nextMessages),
        createdAt: nowIso(),
        isStreaming: true,
      });
    } else {
      targetIndex = placeholderIndex;
      nextMessages[targetIndex] = {
        ...nextMessages[targetIndex],
        id: `${delta.runId}:comment:${delta.version}`,
      };
    }
  }

  const current = nextMessages[targetIndex];
  nextMessages[targetIndex] = {
    ...current,
    content: `${current.content}${delta.content}`,
    streamingChunk: delta.content,
    isStreaming: true,
  };
  return sortMessagesBySequence(nextMessages);
}

function applyAssistantCommentDoneToMessages(
  messages: AIMessage[],
  event: Extract<WSServerMessage, { type: "assistant.comment_done" }>
): AIMessage[] {
  let completedBoundary = 0;
  const nextMessages = messages.flatMap((message) => {
    if (message.role !== "assistant") return [message];
    if (message.id.startsWith(`${event.runId}:comment:`) && message.isStreaming) {
      return [{ ...message, isStreaming: false }];
    }
    if (message.id !== `${event.runId}:runtime` && message.id !== `${event.runId}:draft`) {
      return [message];
    }
    if (!message.content.trim() && !message.toolCalls?.length) return [];
    completedBoundary += 1;
    return [
      {
        ...message,
        id: `${event.runId}:comment:completed:${message.sequence ?? completedBoundary}:${completedBoundary}`,
        isStreaming: false,
      },
    ];
  });
  return ensureActiveRuntimePlaceholder(nextMessages, event.runId);
}

function ensureActiveRuntimePlaceholder(messages: AIMessage[], runId: string): AIMessage[] {
  if (
    messages.some(
      (message) =>
        message.role === "assistant" &&
        (message.id === `${runId}:runtime` || message.id === `${runId}:draft`)
    )
  ) {
    return sortMessagesBySequence(messages);
  }
  return sortMessagesBySequence([
    ...messages,
    {
      id: `${runId}:runtime`,
      role: "assistant",
      content: "",
      sequence: nextMessageSequence(messages),
      createdAt: nowIso(),
      isStreaming: true,
    },
  ]);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function clearActiveToolBoundaryStreamingWhenTextStarted(
  messages: AIMessage[],
  activeRunId: string | null
): AIMessage[] {
  if (!activeRunId) return messages;
  const activeTextStarted = messages.some(
    (message) =>
      message.role === "assistant" &&
      (message.id === `${activeRunId}:runtime` || message.id === `${activeRunId}:draft`) &&
      message.content.trim().length > 0
  );
  if (!activeTextStarted) return messages;

  return messages.map((message) => {
    const hasActiveRunToolCall = message.toolCalls?.some(
      (toolCall) => toolCall.runId === activeRunId
    );
    if (!hasActiveRunToolCall) return message;
    return { ...message, isStreaming: false };
  });
}

function normalizeSnapshotMessages(snapshot: AIConversationRuntimeSnapshot): AIMessage[] {
  return normalizeConversationMessages(snapshot.messages, snapshot.conversation.id);
}

function normalizeConversationMessages(messages: unknown[], conversationId: string): AIMessage[] {
  return sortMessagesBySequence(
    messages
      .map((message, index) => normalizeConversationMessage(message, conversationId, index))
      .filter((message): message is AIMessage => message !== null)
  );
}

function normalizeConversationMessage(
  value: unknown,
  conversationId: string,
  index: number
): AIMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;
  const id =
    typeof message.id === "string" && message.id.length > 0
      ? message.id
      : `${conversationId}:message:${index}`;
  return {
    id,
    role,
    content: typeof message.content === "string" ? message.content : "",
    sequence: typeof message.sequence === "number" ? message.sequence : index,
    attachments: Array.isArray(message.attachments)
      ? (message.attachments as AIMessage["attachments"])
      : undefined,
    createdAt:
      typeof message.createdAt === "string" && message.createdAt.length > 0
        ? message.createdAt
        : undefined,
    toolCalls: Array.isArray(message.toolCalls)
      ? normalizeMessageToolCalls(message.toolCalls, id)
      : undefined,
    resourceReferences: Array.isArray(message.resourceReferences)
      ? (message.resourceReferences as AIResourceReference[])
      : undefined,
    changedResourceReferences: Array.isArray(message.changedResourceReferences)
      ? (message.changedResourceReferences as AIResourceReference[])
      : undefined,
    compactMarker: message.compactMarker === true,
    compactVersion:
      typeof message.compactVersion === "number" && Number.isFinite(message.compactVersion)
        ? Math.max(1, Math.trunc(message.compactVersion))
        : undefined,
    compactEpoch:
      typeof message.compactEpoch === "number" && Number.isFinite(message.compactEpoch)
        ? Math.max(0, Math.trunc(message.compactEpoch))
        : undefined,
    compactBoundaryMessageId:
      typeof message.compactBoundaryMessageId === "string"
        ? message.compactBoundaryMessageId
        : undefined,
    compactedMessageCount:
      typeof message.compactedMessageCount === "number" &&
      Number.isFinite(message.compactedMessageCount)
        ? Math.max(0, Math.trunc(message.compactedMessageCount))
        : undefined,
    sourceTokenEstimate:
      typeof message.sourceTokenEstimate === "number" &&
      Number.isFinite(message.sourceTokenEstimate)
        ? Math.max(0, Math.trunc(message.sourceTokenEstimate))
        : undefined,
    resultTokenEstimate:
      typeof message.resultTokenEstimate === "number" &&
      Number.isFinite(message.resultTokenEstimate)
        ? Math.max(0, Math.trunc(message.resultTokenEstimate))
        : undefined,
    compactTrigger:
      message.compactTrigger === "automatic" || message.compactTrigger === "manual"
        ? message.compactTrigger
        : message.compactTrigger === "auto"
          ? "automatic"
          : undefined,
    compactTailMessageCount:
      typeof message.compactTailMessageCount === "number" &&
      Number.isFinite(message.compactTailMessageCount)
        ? Math.max(0, Math.trunc(message.compactTailMessageCount))
        : undefined,
    conversationStatus: normalizeConversationBlockStatus(message.conversationStatus),
    blockReason: typeof message.blockReason === "string" ? message.blockReason : undefined,
    modelChange: normalizeModelChange(message.modelChange),
    steer: message.steer === true,
    steerPending: message.steerPending === true,
    localOnly: message.localOnly === true,
    runError: message.runError === true,
    runId: typeof message.runId === "string" ? message.runId : undefined,
    clientCommandId:
      typeof message.clientCommandId === "string" ? message.clientCommandId : undefined,
    isStreaming: false,
  };
}

function normalizeModelChange(value: unknown): AIMessage["modelChange"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.fromModel !== "string" || typeof record.toModel !== "string") {
    return undefined;
  }
  return {
    fromModel: record.fromModel,
    toModel: record.toModel,
    fromDisplayName:
      typeof record.fromDisplayName === "string" ? record.fromDisplayName : undefined,
    toDisplayName: typeof record.toDisplayName === "string" ? record.toDisplayName : undefined,
  };
}

function normalizeConversationBlockStatus(
  value: unknown
): Exclude<AIConversationStatus, "active"> | undefined {
  return value === "ended" || value === "context_blocked" ? value : undefined;
}

function applyConversationStatus(
  messages: AIMessage[],
  conversationId: string,
  status: AIConversationStatus | undefined,
  blockReason: string | null | undefined
): AIMessage[] {
  if (status !== "ended" && status !== "context_blocked") return messages;
  if (getConversationBlock(messages)) return messages;
  return sortMessagesBySequence([
    ...messages,
    {
      id: `${conversationId}:status:${status}`,
      role: "assistant",
      content: "",
      sequence: nextMessageSequence(messages),
      conversationStatus: status,
      blockReason: blockReason ?? undefined,
    },
  ]);
}

function normalizeMessageToolCalls(value: unknown[], messageId: string): AIToolCall[] {
  return value
    .map((toolCall, index) => normalizeMessageToolCall(toolCall, messageId, index))
    .filter(
      (toolCall): toolCall is AIToolCall => toolCall !== null && toolCall.name !== "send_comment"
    );
}

function normalizeMessageToolCall(
  value: unknown,
  messageId: string,
  index: number
): AIToolCall | null {
  if (!value || typeof value !== "object") return null;
  const toolCall = value as Record<string, unknown>;
  const functionCall =
    toolCall.function && typeof toolCall.function === "object" && !Array.isArray(toolCall.function)
      ? (toolCall.function as Record<string, unknown>)
      : null;
  const id =
    typeof toolCall.id === "string" && toolCall.id.length > 0
      ? toolCall.id
      : `${messageId}:tool:${index}`;
  const name =
    typeof toolCall.name === "string" && toolCall.name.length > 0
      ? toolCall.name
      : typeof functionCall?.name === "string" && functionCall.name.length > 0
        ? functionCall.name
        : "tool";
  const rawArguments = toolCall.arguments ?? functionCall?.arguments;
  return {
    id,
    name,
    arguments: normalizeToolCallArguments(rawArguments),
    status: normalizeToolCallStatus(toolCall.status),
    approvalPolicy:
      typeof toolCall.approvalPolicy === "string" ? toolCall.approvalPolicy : undefined,
    assistantMessageId:
      typeof toolCall.assistantMessageId === "string" ? toolCall.assistantMessageId : undefined,
    result: toolCall.result,
    error: typeof toolCall.error === "string" ? toolCall.error : undefined,
  };
}

function normalizeToolCallStatus(value: unknown): AIToolCall["status"] {
  if (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "awaiting_approval" ||
    value === "rejected"
  ) {
    return value;
  }
  return "completed";
}

function runtimeToolCallToUI(toolCall: AIRunToolCall): AIToolCall {
  return {
    id: toolCall.toolCallId,
    runId: toolCall.runId,
    roundId: toolCall.roundId,
    position: toolCall.position,
    name: toolCall.toolName,
    arguments: toolCall.toolArgs,
    status: runtimeToolStatusToUI(toolCall.status),
    approvalPolicy: toolCall.approvalPolicy,
    assistantMessageId: toolCall.assistantMessageId,
    result: toolCall.result ?? undefined,
    error: toolCall.error ?? undefined,
  };
}

function pendingQuestionToToolCall(
  question: AIConversationRuntimeSnapshot["runtime"]["pendingQuestions"][number],
  runtimeToolCall?: AIToolCall
): AIToolCall {
  return {
    id: question.toolCallId || question.id,
    name: "ask_question",
    runId: runtimeToolCall?.runId,
    roundId: runtimeToolCall?.roundId,
    position: runtimeToolCall?.position,
    arguments: { question: question.question },
    status: "awaiting_approval",
    result: question.answer ? { answer: question.answer } : undefined,
  };
}

function runtimeToolStatusToUI(status: AIRunToolCall["status"]): AIToolCall["status"] {
  if (status === "pending_approval") return "awaiting_approval";
  if (status === "approved" || status === "running" || status === "created") return "running";
  if (status === "rejected") return "rejected";
  if (status === "failed" || status === "stopped") return "failed";
  return "completed";
}

function attachRuntimeToolCallsToMessages(
  messages: AIMessage[],
  toolCalls: AIToolCall[],
  active: boolean,
  activeRunId: string | null
): AIMessage[] {
  if (toolCalls.length === 0 && !active) return messages;
  const nextMessages = [...messages];
  const unassignedToolCalls: AIToolCall[] = [];
  let activeRunLiveToolCallAttached = false;

  for (const toolCall of toolCalls) {
    const existingToolCallMessageIndex = nextMessages.findIndex((message) =>
      message.toolCalls?.some((existingToolCall) => existingToolCall.id === toolCall.id)
    );
    const belongsToActiveRun = Boolean(active && activeRunId && toolCall.runId === activeRunId);
    const liveActiveToolCall = belongsToActiveRun && isLiveToolCall(toolCall);
    if (existingToolCallMessageIndex !== -1) {
      const mergedToolCalls = mergeToolCalls(
        nextMessages[existingToolCallMessageIndex].toolCalls ?? [],
        [toolCall]
      );
      nextMessages[existingToolCallMessageIndex] = {
        ...nextMessages[existingToolCallMessageIndex],
        isStreaming: liveActiveToolCall
          ? true
          : belongsToActiveRun && !hasLiveActiveRunToolCall(mergedToolCalls, activeRunId)
            ? false
            : nextMessages[existingToolCallMessageIndex].isStreaming,
        toolCalls: mergedToolCalls,
      };
      if (liveActiveToolCall) activeRunLiveToolCallAttached = true;
      continue;
    }

    if (!toolCall.assistantMessageId) {
      unassignedToolCalls.push(toolCall);
      continue;
    }
    const targetIndex = nextMessages.findIndex(
      (message) => message.id === toolCall.assistantMessageId
    );
    if (targetIndex === -1 || nextMessages[targetIndex].role !== "assistant") {
      unassignedToolCalls.push(toolCall);
      continue;
    }
    if (liveActiveToolCall) activeRunLiveToolCallAttached = true;
    const mergedToolCalls = mergeToolCalls(nextMessages[targetIndex].toolCalls ?? [], [toolCall]);
    nextMessages[targetIndex] = {
      ...nextMessages[targetIndex],
      isStreaming: liveActiveToolCall
        ? true
        : belongsToActiveRun && !hasLiveActiveRunToolCall(mergedToolCalls, activeRunId)
          ? false
          : nextMessages[targetIndex].isStreaming,
      toolCalls: mergedToolCalls,
    };
  }

  if (unassignedToolCalls.length === 0) {
    if (
      active &&
      activeRunId &&
      !activeRunLiveToolCallAttached &&
      findActiveRuntimeAssistantIndex(nextMessages, activeRunId) === -1
    ) {
      const sequence = nextMessageSequence(nextMessages);
      nextMessages.push({
        id: `${activeRunId}:runtime`,
        role: "assistant",
        content: "",
        sequence,
        createdAt: nowIso(),
        isStreaming: true,
      });
    }
    return sortMessagesBySequence(nextMessages);
  }

  if (!active) {
    const sequence = nextMessageSequence(nextMessages);
    nextMessages.push({
      id: `toolcalls:${unassignedToolCalls.map((toolCall) => toolCall.id).join(":")}`,
      role: "assistant",
      content: "",
      sequence,
      createdAt: nowIso(),
      isStreaming: false,
      toolCalls: unassignedToolCalls,
    });
    return sortMessagesBySequence(nextMessages);
  }

  let targetIndex =
    active && activeRunId ? findActiveRuntimeAssistantIndex(nextMessages, activeRunId) : -1;
  if (targetIndex === -1 && active && activeRunId) {
    const sequence = nextMessageSequence(nextMessages);
    nextMessages.push({
      id: `${activeRunId}:runtime`,
      role: "assistant",
      content: "",
      sequence,
      createdAt: nowIso(),
      isStreaming: active,
    });
    targetIndex = nextMessages.length - 1;
  }
  if (targetIndex === -1) {
    targetIndex = findLastAssistantIndexAfterLastUser(nextMessages);
  }
  if (targetIndex === -1) {
    const sequence = nextMessageSequence(nextMessages);
    nextMessages.push({
      id: activeRunId ? `${activeRunId}:runtime` : generateId(),
      role: "assistant",
      content: "",
      sequence,
      createdAt: nowIso(),
      isStreaming: active,
    });
    targetIndex = nextMessages.length - 1;
  }

  nextMessages[targetIndex] = {
    ...nextMessages[targetIndex],
    isStreaming: active,
    toolCalls: mergeToolCalls(nextMessages[targetIndex].toolCalls ?? [], unassignedToolCalls),
  };
  return sortMessagesBySequence(nextMessages);
}

function isLiveToolCall(toolCall: AIToolCall): boolean {
  return toolCall.status === "running" || toolCall.status === "awaiting_approval";
}

function hasLiveActiveRunToolCall(toolCalls: AIToolCall[], activeRunId: string | null): boolean {
  return toolCalls.some((toolCall) => toolCall.runId === activeRunId && isLiveToolCall(toolCall));
}

function findActiveRuntimeAssistantIndex(messages: AIMessage[], activeRunId: string): number {
  const runtimeIds = new Set([`${activeRunId}:draft`, `${activeRunId}:runtime`]);
  return messages.findIndex(
    (message) => message.role === "assistant" && runtimeIds.has(message.id)
  );
}

function findActiveCommentIndex(messages: AIMessage[], activeRunId: string): number {
  return findLastIndex(
    messages,
    (message) => message.role === "assistant" && message.id.startsWith(`${activeRunId}:comment:`)
  );
}

function mergeToolCalls(existing: AIToolCall[], incoming: AIToolCall[]): AIToolCall[] {
  const byId = new Map(existing.map((toolCall) => [toolCall.id, toolCall]));
  for (const toolCall of incoming) {
    const previous = byId.get(toolCall.id);
    byId.set(toolCall.id, {
      ...previous,
      ...toolCall,
      arguments: { ...(previous?.arguments ?? {}), ...toolCall.arguments },
    });
  }
  return [...byId.values()];
}

function normalizeToolCallArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function patchRecentConversationFromSnapshot(
  conversations: AIConversationSummary[],
  snapshot: AIConversationRuntimeSnapshot
): AIConversationSummary[] {
  const existing = conversations.find(
    (conversation) => conversation.id === snapshot.conversation.id
  );
  const nextConversation: AIConversationSummary = {
    id: snapshot.conversation.id,
    title: snapshot.conversation.title,
    createdAt: snapshot.conversation.createdAt,
    updatedAt: snapshot.conversation.updatedAt,
    lastUserMessageAt:
      snapshot.conversation.lastUserMessageAt ??
      snapshotLastUserMessageAt(snapshot.messages) ??
      existing?.lastUserMessageAt ??
      snapshot.conversation.createdAt,
    folderId: snapshot.conversation.folderId ?? existing?.folderId ?? null,
    messageCount: snapshot.conversation.messageCount ?? snapshot.messages.length,
    status: snapshot.conversation.status ?? existing?.status ?? "active",
    blockReason: snapshot.conversation.blockReason ?? existing?.blockReason ?? null,
    activeRunStatus: snapshot.runtime.activeRun?.status ?? null,
    planStatus: snapshot.runtime.activePlan?.status ?? existing?.planStatus ?? null,
  };
  const found = Boolean(existing);
  const next = found
    ? conversations.map((conversation) =>
        conversation.id === nextConversation.id
          ? { ...conversation, ...nextConversation }
          : conversation
      )
    : [nextConversation, ...conversations];
  return sortConversationSummaries(next);
}

function patchRecentConversationRunStatus(
  conversations: AIConversationSummary[],
  conversationId: string,
  activeRunStatus: AIConversationSummary["activeRunStatus"]
): AIConversationSummary[] {
  let changed = false;
  const nextConversations = conversations.map((conversation) => {
    if (conversation.id !== conversationId) return conversation;
    if (conversation.activeRunStatus === activeRunStatus) return conversation;
    changed = true;
    return { ...conversation, activeRunStatus };
  });
  return changed ? nextConversations : conversations;
}

function sortConversationFolders(folders: AIConversationFolder[]): AIConversationFolder[] {
  return [...folders].sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}

function sortConversationSummaries(
  conversations: AIConversationSummary[]
): AIConversationSummary[] {
  return [...conversations].sort((left, right) => {
    const rightTime = Date.parse(right.lastUserMessageAt ?? right.createdAt);
    const leftTime = Date.parse(left.lastUserMessageAt ?? left.createdAt);
    return rightTime - leftTime;
  });
}

function snapshotLastUserMessageAt(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "user") continue;
    return typeof record.createdAt === "string" ? record.createdAt : null;
  }
  return null;
}

function findLastAssistantIndexAfterLastUser(messages: AIMessage[]): number {
  const lastUserIndex = findLastUserIndex(messages);
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    if (messages[index].role === "assistant") return index;
  }
  return -1;
}

function findLastUserIndex(messages: AIMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

function nextMessageSequence(messages: AIMessage[]): number {
  return (
    messages.reduce(
      (max, message, index) =>
        Math.max(max, typeof message.sequence === "number" ? message.sequence : index),
      -1
    ) + 1
  );
}

function sortMessagesBySequence(messages: AIMessage[]): AIMessage[] {
  return [...messages].sort((left, right) => {
    const leftSequence = typeof left.sequence === "number" ? left.sequence : messages.indexOf(left);
    const rightSequence =
      typeof right.sequence === "number" ? right.sequence : messages.indexOf(right);
    if (leftSequence !== rightSequence) return leftSequence - rightSequence;
    return messages.indexOf(left) - messages.indexOf(right);
  });
}

function isActiveRunStatus(status: string | null | undefined): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_approval" ||
    status === "waiting_for_answer" ||
    status === "waiting_for_credential" ||
    status === "waiting_for_setup"
  );
}

const DEV_APPROVAL_MESSAGE_ID = "dev-approval-preview-message";
const DEV_APPROVAL_TOOL_CALL_ID = "dev-approval-preview-tool";
const DEV_CHANGED_RESOURCES_MESSAGE_ID = "dev-changed-resources-preview-message";
const DEV_PLAN_PREVIEW_ID = "dev-plan-progress-preview";

function installAIResourcePreviewCommands(): void {
  if (typeof window === "undefined") return;

  window.gatewayDev = {
    ...(window.gatewayDev ?? {}),
    showChangedResources: () => {
      useUIStore.setState({ aiPanelOpen: true });
      useAIStore.setState((state) => ({
        messages: [
          ...state.messages.filter((message) => message.id !== DEV_CHANGED_RESOURCES_MESSAGE_ID),
          {
            id: DEV_CHANGED_RESOURCES_MESSAGE_ID,
            role: "assistant",
            content: "",
            createdAt: nowIso(),
            changedResourceReferences: [
              {
                refId: "gwr_000000000000000000000001",
                type: "node",
                resourceId: "dev-preview-node",
                label: "docker-src",
                relation: "updated",
                slug: "docker-src",
              },
              {
                refId: "gwr_000000000000000000000002",
                type: "docker_container",
                resourceId: "dev-preview-container",
                label: "ai-e2e-restart",
                relation: "created",
                nodeSlug: "docker-src",
              },
              {
                refId: "gwr_000000000000000000000003",
                type: "docker_volume",
                resourceId: "ai-e2e-restart-data",
                label: "ai-e2e-restart-data",
                relation: "updated",
                nodeSlug: "docker-src",
              },
            ],
          },
        ],
      }));
    },
    hideChangedResources: () => {
      useAIStore.setState((state) => ({
        messages: state.messages.filter(
          (message) => message.id !== DEV_CHANGED_RESOURCES_MESSAGE_ID
        ),
      }));
    },
    showPlanProgress: () => {
      const now = new Date();
      const publishedAt = new Date(now.getTime() - 60_000).toISOString();
      useUIStore.setState({ aiPanelOpen: true });
      useAIStore.setState((state) => ({
        activeConversationId: state.activeConversationId ?? "00000000-0000-4000-8000-000000000001",
        devPlanProgressPreview: {
          id: DEV_PLAN_PREVIEW_ID,
          conversationId: state.activeConversationId ?? "00000000-0000-4000-8000-000000000001",
          status: "executing",
          title: "Implement Gateway plan mode",
          model: state.selectedModel,
          reasoningEffort: state.selectedReasoningEffort,
          revisionId: `${DEV_PLAN_PREVIEW_ID}-revision`,
          revision: 1,
          revisionStatus: "accepted",
          publishedAt,
          timelineAnchorAt: publishedAt,
          acceptedAt: publishedAt,
          goal: "Complete and verify the requested Gateway changes.",
          scope: ["Gateway UI", "Plan execution"],
          assumptions: [],
          research: [],
          intentReview: { verdict: "pass", summary: "The plan matches the request.", findings: [] },
          securityReview: {
            verdict: "pass",
            summary: "The plan is safe to execute.",
            findings: [],
          },
          verification: [],
          changeSummary: null,
          steps: [
            {
              id: `${DEV_PLAN_PREVIEW_ID}-step-1`,
              ordinal: 0,
              title: "Inspect current behavior",
              description: "Confirm the existing Plan Mode flow.",
              verification: "The current behavior is documented.",
              status: "completed",
              evidence: [{ summary: "Current behavior inspected." }],
              skipReason: null,
              startedAt: publishedAt,
              completedAt: publishedAt,
            },
            {
              id: `${DEV_PLAN_PREVIEW_ID}-step-2`,
              ordinal: 1,
              title: "Implement the requested changes",
              description: "Update the active Plan Mode experience.",
              verification: "The updated behavior works in the UI.",
              status: "in_progress",
              evidence: [],
              skipReason: null,
              startedAt: now.toISOString(),
              completedAt: null,
            },
            {
              id: `${DEV_PLAN_PREVIEW_ID}-step-3`,
              ordinal: 2,
              title: "Verify the result",
              description: "Run targeted checks and browser verification.",
              verification: "All requested behavior is verified.",
              status: "pending",
              evidence: [],
              skipReason: null,
              startedAt: null,
              completedAt: null,
            },
          ],
          noProgressRuns: 0,
          activeTimeMs: 64_000,
          activeSince: now.toISOString(),
          pauseReason: null,
          createdAt: publishedAt,
          updatedAt: now.toISOString(),
        },
      }));
    },
    hidePlanProgress: () => {
      useAIStore.setState({ devPlanProgressPreview: null });
    },
  };
}

function installAIDevCommands(): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;

  window.gatewayDev = {
    ...(window.gatewayDev ?? {}),
    showApprovalBlock: () => {
      useUIStore.setState({ aiPanelOpen: true });
      useAIStore.setState((state) => ({
        messages: [
          ...state.messages.filter((message) => message.id !== DEV_APPROVAL_MESSAGE_ID),
          {
            id: DEV_APPROVAL_MESSAGE_ID,
            role: "assistant",
            content: "",
            createdAt: nowIso(),
            localOnly: true,
            isStreaming: true,
            toolCalls: [
              {
                id: DEV_APPROVAL_TOOL_CALL_ID,
                name: "run_process",
                arguments: { command: "echo preview" },
                status: "awaiting_approval",
              },
            ],
          },
        ],
        activeConversationId: state.activeConversationId ?? "00000000-0000-4000-8000-000000000001",
        activeRunId: state.activeRunId ?? "dev-approval-preview-run",
        isConnected: true,
        retryAfter: null,
      }));
    },
    hideApprovalBlock: () => {
      useAIStore.setState((state) => ({
        messages: state.messages.filter((message) => message.id !== DEV_APPROVAL_MESSAGE_ID),
      }));
    },
  };
}

installAIResourcePreviewCommands();
installAIDevCommands();

// Auto-manage WS lifecycle based on visible AI surfaces.
// This runs outside React — no component mount/unmount issues.
let prevAIActive = false;
function syncAIWebSocketLifecycle(state: ReturnType<typeof useUIStore.getState>) {
  // The persisted UI value is only a visual preference. Wait for the
  // user-scoped preference load before opening a socket, otherwise startup
  // briefly opens AI from persisted state, closes it during hydration, then
  // opens it again with the server preference.
  const active = state.interfacePreferenceLoaded && (state.aiPanelOpen || state.aiLiteMode);
  if (active !== prevAIActive) {
    prevAIActive = active;
    if (active) {
      useAIStore.getState().connect();
    } else {
      useAIStore.getState().disconnect();
    }
  }
}
useUIStore.subscribe(syncAIWebSocketLifecycle);
syncAIWebSocketLifecycle(useUIStore.getState());

let prevAuthUserId: string | null = useAuthStore.getState().user?.id ?? null;
let prevAuthLoading = useAuthStore.getState().isLoading;
useAuthStore.subscribe((state) => {
  const nextUserId = state.user?.id ?? null;
  const authChanged = prevAuthUserId !== nextUserId || prevAuthLoading !== state.isLoading;
  prevAuthUserId = nextUserId;
  prevAuthLoading = state.isLoading;

  const ui = useUIStore.getState();
  const aiActive = ui.interfacePreferenceLoaded && (ui.aiPanelOpen || ui.aiLiteMode);
  if (!authChanged || !aiActive) return;
  if (state.user) {
    void useAIStore.getState().connect();
  } else if (!state.isLoading) {
    useAIStore.setState({ isConnecting: false, connectionError: "Not authenticated" });
  }
});
