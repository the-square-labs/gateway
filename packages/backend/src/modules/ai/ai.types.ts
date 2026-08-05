import type { AIConversationRuntimeSnapshot } from './ai-run.service.js';

// ── AI Configuration (stored in settings table) ──

export type WebSearchProvider = 'tavily' | 'brave' | 'serper' | 'searxng' | 'exa';

export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'none';
export type AIEndpointMode = 'auto' | 'chat_completions' | 'responses';
export type AIProviderType = 'openai_compatible' | 'gateway_inference';

export interface AIConfig {
  enabled: boolean;
  providerType: AIProviderType;
  providerUrl: string;
  endpointMode: AIEndpointMode;
  supportsImages: boolean;
  model: string;
  gatewayInferenceModel: string;
  gatewayInferenceAllowUserModelSelection: boolean;
  maxCompletionTokens: number;
  maxTokensField: MaxTokensField;
  reasoningEffort: ReasoningEffort;
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
  sandboxDefaultTier: 'low' | 'medium' | 'high';
}

export interface EncryptedValue {
  encryptedKey: string;
  encryptedDek: string;
}

// ── Tool Definitions ──

export interface AIToolHistoryRetention {
  mode: 'persistent_context' | 'recent_full' | 'summary_only' | 'never_full';
  maxBytes?: number;
}

export interface AIToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  destructive: boolean;
  category: string;
  requiredScope: string;
  invalidateStores: string[];
  historyRetention?: AIToolHistoryRetention;
}

// ── Page Context (from frontend) ──

export interface PageContext {
  route: string;
  resourceType?: string;
  resourceId?: string;
}

// ── Chat Messages (OpenAI-compatible) ──

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  attachments?: AIMessageAttachment[];
  tool_calls?: Array<{
    id: string;
    type: 'function';
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
  kind: 'image';
}

export type AIConversationStatus = 'active' | 'ended' | 'context_blocked';

// ── WebSocket Protocol ──

export type WSClientMessage =
  | { type: 'conversation.subscribe'; conversationId: string; clientCommandId?: string }
  | { type: 'conversation.unsubscribe'; conversationId: string }
  | { type: 'conversation.sync'; conversationId: string; clientCommandId?: string }
  | {
      type: 'conversation.compact';
      conversationId: string;
      clientCommandId: string;
      context?: PageContext;
      model?: string;
      reasoningEffort?: string;
    }
  | {
      type: 'conversation.send_message';
      clientCommandId: string;
      conversationId?: string;
      content: string;
      attachments?: AIMessageAttachment[];
      context?: PageContext;
      model?: string;
      reasoningEffort?: string;
    }
  | { type: 'run.stop'; conversationId: string; runId: string; clientCommandId: string }
  | {
      type: 'approval.decide';
      conversationId: string;
      runId: string;
      approvalId: string;
      decision: 'approved' | 'rejected';
      clientCommandId: string;
    }
  | {
      type: 'question.answer';
      conversationId: string;
      runId: string;
      questionId: string;
      answer: string;
      clientCommandId: string;
    }
  | {
      type: 'credential.resolve';
      conversationId: string;
      runId: string;
      challengeId: string;
      decision: 'authorized' | 'rejected';
      clientCommandId: string;
    }
  | { type: 'ping' };

export type WSServerMessage =
  | { type: 'auth_ok'; userId: string }
  | { type: 'auth_error'; message: string }
  | { type: 'text_delta'; requestId: string; content: string }
  | { type: 'assistant_comment_delta'; requestId: string; content: string }
  | { type: 'assistant_comment'; requestId: string; content: string }
  | { type: 'tool_call_start'; requestId: string; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_approval_required'; requestId: string; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; requestId: string; id: string; name: string; result: unknown; error?: string }
  | {
      type: 'credential_authorization_required';
      requestId: string;
      id: string;
      name: string;
      provider: 'gitlab';
      connectorId: string;
      arguments: Record<string, unknown>;
    }
  | { type: 'invalidate_stores'; requestId: string; stores: string[] }
  | { type: 'conversation_ended'; requestId: string; reason: string }
  | { type: 'context_blocked'; requestId: string; reason: string }
  | { type: 'done'; requestId: string }
  | { type: 'error'; requestId: string; message: string; code?: string }
  | { type: 'rate_limited'; retryAfter: number }
  | {
      type: 'command.ack';
      commandType: WSClientMessage['type'];
      clientCommandId?: string;
      conversationId?: string;
      runId?: string;
      duplicate?: boolean;
    }
  | {
      type: 'command.error';
      commandType?: WSClientMessage['type'] | string;
      clientCommandId?: string;
      conversationId?: string;
      runId?: string;
      code: string;
      message: string;
      statusCode?: number;
    }
  | { type: 'conversation.snapshot'; conversationId: string; snapshot: AIConversationRuntimeSnapshot }
  | { type: 'assistant.delta'; conversationId: string; runId: string; content: string; version: number }
  | { type: 'assistant.comment_delta'; conversationId: string; runId: string; content: string; version: number }
  | { type: 'assistant.comment_done'; conversationId: string; runId: string }
  | {
      type: 'credential.required';
      conversationId: string;
      runId: string;
      challenge: NonNullable<AIConversationRuntimeSnapshot['runtime']['pendingCredentialChallenge']>;
    }
  | { type: 'client.action'; conversationId: string; runId: string; action: Record<string, unknown> }
  | { type: 'run.status_changed'; conversationId: string; run: AIConversationRuntimeSnapshot['runtime']['activeRun'] }
  | { type: 'stores.invalidated'; conversationId: string; stores: string[] }
  | {
      type: 'approval.updated';
      conversationId: string;
      runId: string;
      approval: AIConversationRuntimeSnapshot['runtime']['toolCalls'][number];
      duplicate: boolean;
    }
  | {
      type: 'question.answered';
      conversationId: string;
      runId: string;
      question: NonNullable<AIConversationRuntimeSnapshot['runtime']['pendingQuestion']>;
      duplicate: boolean;
    }
  | {
      type: 'credential.updated';
      conversationId: string;
      runId: string;
      challenge: AIConversationRuntimeSnapshot['runtime']['pendingCredentialChallenge'];
      duplicate: boolean;
    }
  | { type: 'pong' };

// ── AI Question (ask_question tool) ──

export interface AIQuestionOption {
  label: string;
  description?: string;
}

export interface AIQuestion {
  questionId: string;
  question: string;
  options?: AIQuestionOption[];
  allowFreeText: boolean;
}

// ── Tool Execution Result ──

export interface ToolExecutionResult {
  result?: unknown;
  error?: string;
  credentialChallenge?: {
    provider: 'gitlab';
    connectorId: string;
  };
  invalidateStores: string[];
}

export interface ToolExecutionOptions {
  source?: 'ai' | 'mcp';
  pageContext?: PageContext;
  conversationId?: string;
  scopes?: string[];
  tokenId?: string;
  tokenPrefix?: string;
  authType?: 'oauth' | 'api-token';
  clientId?: string;
}
