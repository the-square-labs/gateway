// ── AI Tool Call ──

export interface AIToolCall {
  id: string;
  runId?: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "running" | "completed" | "failed" | "awaiting_approval" | "rejected";
  approvalPolicy?: string;
  assistantMessageId?: string | null;
  result?: unknown;
  error?: string;
}

export type AIConversationStatus = "active" | "ended" | "context_blocked";

// ── AI Message ──

export interface AIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sequence?: number;
  attachments?: AIMessageAttachment[];
  createdAt?: string;
  toolCalls?: AIToolCall[];
  isStreaming?: boolean;
  localOnly?: boolean;
  runError?: boolean;
  runId?: string;
  compactMarker?: boolean;
  compactTailMessageCount?: number;
  conversationStatus?: Exclude<AIConversationStatus, "active">;
  blockReason?: string;
  modelChange?: {
    fromModel: string;
    toModel: string;
    fromDisplayName?: string;
    toDisplayName?: string;
  };
  rawToolCalls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

// ── AI Configuration ──

export type WebSearchProvider = "tavily" | "brave" | "serper" | "searxng" | "exa";
export type AIEndpointMode = "auto" | "chat_completions" | "responses";
export type AIProviderType = "openai_compatible" | "gateway_inference";

export interface AIInferenceModelOption {
  id: string;
  displayName: string;
  supportsImages: boolean;
  maxContextTokens: number;
  maxOutputTokens: number | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

export interface AIProviderStatus {
  enabled: boolean;
  providerType: AIProviderType;
  defaultModel: string;
  allowUserModelSelection: boolean;
  supportsImages: boolean;
  models: AIInferenceModelOption[];
}

export interface AIConfig {
  enabled: boolean;
  providerType: AIProviderType;
  providerUrl: string;
  endpointMode: AIEndpointMode;
  supportsImages: boolean;
  model: string;
  gatewayInferenceModel: string;
  gatewayInferenceAllowUserModelSelection: boolean;
  gatewayInferenceModels: AIInferenceModelOption[];
  maxCompletionTokens: number;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  reasoningEffort: "low" | "medium" | "high" | "none";
  customSystemPrompt: string;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  maxToolRounds: number;
  maxContextTokens: number;
  disabledTools: string[];
  webSearchEnabled: boolean;
  webSearchProvider: WebSearchProvider;
  webSearchBaseUrl: string;
  sandboxEnabled: boolean;
  sandboxDefaultTier: "low" | "medium" | "high";
  hasApiKey: boolean;
  apiKeyLast4: string;
  hasWebSearchKey: boolean;
  webSearchApiKeyLast4: string;
}

export interface AIContextEstimate {
  systemTokens: number;
  toolsTokens: number;
  totalOverhead: number;
  limit: number;
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

export interface AISandboxStatus {
  state: "stopped" | "starting" | "running" | "unavailable";
  socketPath?: string;
  pid?: number;
  lastError?: string;
}

export interface AISandboxJob {
  id: string;
  userId: string;
  conversationId: string | null;
  kind: "script" | "process";
  runtime: "alpine" | "node" | "python";
  resourceTier: "low" | "medium" | "high";
  requestedTtlSeconds: number;
  effectiveTtlSeconds: number;
  requiredScopes: string[];
  status: "queued" | "running" | "exited" | "killed" | "timeout" | "failed" | "revoked" | "expired";
  containerId: string | null;
  exitCode: number | null;
  outputBytes: number;
  revocationReason: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
}

export interface AISandboxOutput {
  processId: string;
  output: string;
  outputBytes: number;
}

export interface AISandboxArtifact {
  id: string;
  userId: string;
  conversationId: string | null;
  conversationTitle: string | null;
  sourceProcessId: string;
  sourcePath: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
  downloadUrl: string;
}

// ── Page Context ──

export interface PageContext {
  route: string;
  resourceType?: string;
  resourceId?: string;
}

// ── Quick Action ──

export interface QuickAction {
  label: string;
  prompt: string;
}

// ── Chat Message (for API) ──

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  attachments?: AIMessageAttachment[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface AIMessageAttachment {
  artifactId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  downloadUrl: string;
  kind: "image";
}

export interface AIComposerLocalImageAttachment {
  localId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  dataUrl: string;
  previewUrl: string;
  kind: "image";
}

export type AIComposerAttachment = AIMessageAttachment | AIComposerLocalImageAttachment;

// ── Backend-owned AI Runtime ──

export type AIRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_answer"
  | "waiting_for_credential"
  | "completed"
  | "failed"
  | "stopped";

export interface AIRun {
  id: string;
  conversationId: string;
  userId: string;
  status: AIRunStatus;
  activeMessageId: string | null;
  clientCommandId: string;
  assistantDraftContent: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AIRunToolCallStatus =
  | "created"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export interface AIRunToolCall {
  id: string;
  runId: string;
  conversationId: string;
  assistantMessageId: string | null;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  classification: string;
  approvalPolicy: string;
  requiredScopes: string[];
  status: AIRunToolCallStatus;
  decision: "approved" | "rejected" | null;
  result: unknown | null;
  error: string | null;
}

export interface AIRunQuestion {
  id: string;
  runId: string;
  conversationId: string;
  toolCallId: string;
  question: string;
  status: "pending" | "answered" | "stopped";
  answer: string | null;
}

export interface AICredentialChallenge {
  id: string;
  runId: string;
  conversationId: string;
  userId: string;
  provider: "gitlab";
  connectorId: string;
  toolCallId: string;
  toolName: string;
  status: "pending" | "authorized" | "rejected" | "stopped";
  decisionClientCommandId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AIRuntimeSnapshot {
  activeRun: AIRun | null;
  assistantDraftContent?: string | null;
  assistantDraftVersion?: number | null;
  pendingApprovals: AIRunToolCall[];
  pendingQuestion: AIRunQuestion | null;
  pendingQuestions: AIRunQuestion[];
  pendingCredentialChallenge?: AICredentialChallenge | null;
  toolCalls: AIRunToolCall[];
}

export interface AIConversationRuntimeSnapshot {
  conversation: {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    folderId?: string | null;
    lastUserMessageAt?: string | null;
    messageCount?: number;
    status?: AIConversationStatus;
    blockReason?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    lastContext: PageContext | null;
    discoveredToolsets: string[];
    checkpoint: Record<string, unknown> | null;
  };
  messages: unknown[];
  runtime: AIRuntimeSnapshot;
}

// ── WebSocket Messages ──

export type WSClientMessage =
  | { type: "conversation.subscribe"; conversationId: string; clientCommandId?: string }
  | { type: "conversation.unsubscribe"; conversationId: string }
  | { type: "conversation.sync"; conversationId: string; clientCommandId?: string }
  | {
      type: "conversation.compact";
      conversationId: string;
      clientCommandId: string;
      context?: PageContext;
      model?: string;
      reasoningEffort?: string;
    }
  | {
      type: "conversation.send_message";
      clientCommandId: string;
      conversationId?: string;
      content: string;
      attachments?: AIMessageAttachment[];
      context?: PageContext;
      model?: string;
      reasoningEffort?: string;
    }
  | { type: "run.stop"; conversationId: string; runId: string; clientCommandId: string }
  | {
      type: "approval.decide";
      conversationId: string;
      runId: string;
      approvalId: string;
      decision: "approved" | "rejected";
      clientCommandId: string;
    }
  | {
      type: "question.answer";
      conversationId: string;
      runId: string;
      questionId: string;
      answer: string;
      clientCommandId: string;
    }
  | {
      type: "credential.resolve";
      conversationId: string;
      runId: string;
      challengeId: string;
      decision: "authorized" | "rejected";
      clientCommandId: string;
    }
  | { type: "ping" };

export type WSServerMessage =
  | { type: "auth_ok"; userId: string }
  | { type: "auth_error"; message: string }
  | {
      type: "command.ack";
      commandType: WSClientMessage["type"];
      clientCommandId?: string;
      conversationId?: string;
      runId?: string;
      duplicate?: boolean;
    }
  | {
      type: "command.error";
      commandType?: WSClientMessage["type"] | string;
      clientCommandId?: string;
      conversationId?: string;
      runId?: string;
      code: string;
      message: string;
      statusCode?: number;
    }
  | {
      type: "conversation.snapshot";
      conversationId: string;
      snapshot: AIConversationRuntimeSnapshot;
    }
  | {
      type: "assistant.delta";
      conversationId: string;
      runId: string;
      content: string;
      version: number;
    }
  | {
      type: "assistant.comment_delta";
      conversationId: string;
      runId: string;
      content: string;
      version: number;
    }
  | {
      type: "assistant.comment_done";
      conversationId: string;
      runId: string;
    }
  | {
      type: "credential.required";
      conversationId: string;
      runId: string;
      challenge: AICredentialChallenge;
    }
  | { type: "run.status_changed"; conversationId: string; run: AIRun | null }
  | { type: "stores.invalidated"; conversationId: string; stores: string[] }
  | {
      type: "approval.updated";
      conversationId: string;
      runId: string;
      approval: AIRunToolCall;
      duplicate: boolean;
    }
  | {
      type: "question.answered";
      conversationId: string;
      runId: string;
      question: AIRunQuestion;
      duplicate: boolean;
    }
  | {
      type: "credential.updated";
      conversationId: string;
      runId: string;
      challenge: AICredentialChallenge;
      duplicate: boolean;
    }
  | { type: "pong" };

// ── Tool definition (from admin API) ──

export interface AIToolDef {
  name: string;
  description: string;
  destructive: boolean;
  requiredRole: string;
}
