import { randomUUID } from 'node:crypto';
import { container, TOKENS } from '@/container.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { createChildLogger } from '@/lib/logger.js';
import type { User } from '@/types.js';
import { AI_TOOLS, type getOpenAITools } from './ai.tools.js';
import type {
  AIPlanRuntimeSnapshot,
  AIResourceReference,
  AIToolDefinition,
  ChatMessage,
  PageContext,
  WSServerMessage,
} from './ai.types.js';
import { getAIToolApprovalDecision } from './ai-approval-policy.js';
import { redactOneTimeSecretToolResult } from './ai-secret-result-redaction.js';

export const logger = createChildLogger('AIService');

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export const SANDBOX_TOOL_NAMES = new Set([
  'execute_script',
  'run_process',
  'fetch',
  'download_artifact',
  'list_artifact_files',
  'read_artifact',
  'send_artifact',
  'read_process_output',
  'write_process_stdin',
  'kill_process',
  'list_sandbox_jobs',
]);

export type QueuedApproval = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AutoCompactContextHook = (messages: ChatMessage[]) => Promise<ChatMessage[]>;
export type ReceivePendingSteersHook = (messages: ChatMessage[]) => Promise<ChatMessage[]>;

export type ToolRuntimeContext = {
  pageContext?: PageContext;
  conversationId?: string;
};

export type AIContextCompactionTrigger = 'manual' | 'auto';

export interface AIContextCompactionResult {
  compacted: boolean;
  summary: string;
  compactedMessageCount: number;
  compactVersion: 2;
  compactEpoch: number;
  compactBoundaryMessageId: string | null;
  sourceTokenEstimate: number;
  resultTokenEstimate: number;
  trigger: AIContextCompactionTrigger;
  preCompactionTokens?: number;
  reconstructedTokens?: number;
  targetTokens?: number;
  targetAchieved?: boolean;
}

export const SEND_COMMENT_TOOL_NAME = 'send_comment';
export const TOOL_COMMENT_REQUIRED_MESSAGE =
  'You have reached the maximum number of sequential tool-call rounds without a user-visible progress comment. Call only send_comment now with a concise, useful progress update. If this run already contains user-visible assistant text, use exactly the same language; otherwise use the response language selected for this run. Keep that language for every later comment and the final answer. Do not call any other tool in this response.';
export const SEND_COMMENT_EMPTY_ERROR =
  'send_comment requires a real, non-empty progress comment for the user. Call send_comment again in the response language already selected for this run.';
export const SEND_COMMENT_MIXED_ERROR =
  'send_comment must be called by itself. First send the progress comment, then call other tools in the next assistant turn.';
export const RUN_LANGUAGE_LOCK_MESSAGE =
  'The response language for this run is now locked to the language of the first user-visible assistant text. Use that same language for every later progress update, question, and final answer in this run. Do not switch because tool results, documentation, or the original request use another language. Only a later user message explicitly requesting a language change may override this lock.';

export function hasRunLanguageLock(messages: Array<{ role?: unknown; content?: unknown }>): boolean {
  return messages.some((message) => message.role === 'system' && message.content === RUN_LANGUAGE_LOCK_MESSAGE);
}

export function ensureRuntimeLanguageLock(messages: ChatMessage[]): void {
  if (hasRunLanguageLock(messages)) return;
  messages.push({
    role: 'system',
    content: RUN_LANGUAGE_LOCK_MESSAGE,
    hiddenSystemEvent: true,
  });
}

export function ensureProviderLanguageLock(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!hasRunLanguageLock(messages)) {
    messages.push({ role: 'system', content: RUN_LANGUAGE_LOCK_MESSAGE });
  }
  return messages;
}

export function latestToolRoundHasUserVisibleAssistantText(messages: Record<string, unknown>[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    if (typeof message.content === 'string' && message.content.trim()) return true;
    return message.tool_calls.some((call) => {
      if (!isRecord(call) || !isRecord(call.function)) return false;
      return call.function.name === 'ask_question' || call.function.name === SEND_COMMENT_TOOL_NAME;
    });
  }
  return false;
}

export const PLAN_LIFECYCLE_TOOL_NAMES = new Set([
  'enter_plan_mode',
  'submit_plan',
  'submit_plan_review',
  'start_plan_execution',
  'update_plan_step',
  'pause_plan_execution',
  'resume_plan_execution',
  'finalize_plan_execution',
  'submit_plan_verification',
]);

export function isToolNameAllowedForPlanState(
  toolName: string,
  status: AIPlanRuntimeSnapshot['status'] | null
): boolean {
  return (
    planningRuntime()?.isToolNameAllowedForPlanState(toolName, status) ??
    (status === null && !PLAN_LIFECYCLE_TOOL_NAMES.has(toolName))
  );
}

export function isToolAllowedForPlanState(
  tool: AIToolDefinition,
  status: AIPlanRuntimeSnapshot['status'] | null,
  args?: Record<string, unknown>
): boolean {
  return (
    planningRuntime()?.isToolAllowedForPlanState(tool, status, args) ??
    (status === null && !PLAN_LIFECYCLE_TOOL_NAMES.has(tool.name))
  );
}

export function shouldEndRunAfterPlanTool(toolName: string, result: unknown, error: string | undefined): boolean {
  return planningRuntime()?.shouldEndRunAfterPlanTool(toolName, result, error) ?? false;
}

export function buildPlanRuntimePrompt(plan: AIPlanRuntimeSnapshot): string {
  return planningRuntime()?.buildPlanRuntimePrompt(plan) ?? '';
}

export function isAIResourceAppearanceColor(
  value: unknown
): value is NonNullable<AIResourceReference['appearanceColor']> {
  return (
    value === 'blue' ||
    value === 'red' ||
    value === 'green' ||
    value === 'yellow' ||
    value === 'purple' ||
    value === 'pink' ||
    value === 'orange'
  );
}
export const SEND_COMMENT_REPAIR_LIMIT = 3;

export type ModelTool = ReturnType<typeof getOpenAITools>[number];
export type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
  parsedArgs: Record<string, unknown>;
  validationError?: string;
};

export function isContextWindowError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null
        ? JSON.stringify(error)
        : String(error);
  return /context(?:_| )?(?:length|window)|maximum context|max(?:imum)? tokens|too many tokens/i.test(message);
}

export function conversationEndReason(result: unknown, fallback: string): string {
  if (isRecord(result) && typeof result.reason === 'string' && result.reason.trim()) {
    return result.reason.trim();
  }
  return fallback;
}

export function compactToolResultForModel(toolName: string, value: unknown): unknown {
  if (value == null) return value;
  const redactedValue = redactOneTimeSecretToolResult(toolName, value);
  if (redactedValue !== value) return redactedValue;
  if (toolName === 'send_artifact' && isRecord(value)) {
    const { artifactId, filename, mediaType, sizeBytes, sourcePath, downloadUrl } = value;
    return { artifactId, filename, mediaType, sizeBytes, sourcePath, downloadUrl };
  }
  return value;
}

export function splitToolControlMetadata(
  toolName: string,
  value: unknown
): { modelVisible: unknown; clientAction?: Record<string, unknown> } {
  const compacted = compactToolResultForModel(toolName, value);
  if (!isRecord(compacted) || !isRecord(compacted.clientAction)) return { modelVisible: compacted };
  const { clientAction, ...modelVisible } = compacted;
  return { modelVisible, clientAction };
}

export function toolOutputPreview(serialized: string): string {
  return serialized.length <= 2_048 ? serialized : `${serialized.slice(0, 2_048)}\n…`;
}

export function createToolRoundStartEvent(
  requestId: string,
  calls: PendingToolCall[],
  approvalMode: User['aiApprovalMode'],
  providerMessages: Record<string, unknown>[]
): Extract<WSServerMessage, { type: 'tool_round_start' }> {
  return {
    type: 'tool_round_start',
    requestId,
    roundId: randomUUID(),
    calls: calls.map((call, position) => {
      const decision = getAIToolApprovalDecision(call.name, approvalMode, call.parsedArgs);
      const definition = AI_TOOLS.find((tool) => tool.name === call.name);
      return {
        id: call.id,
        name: call.name,
        arguments: call.parsedArgs,
        position,
        gate: call.name === 'ask_question' ? 'question' : decision.requiresApproval ? 'approval' : 'immediate',
        classification: decision.classification,
        approvalPolicy: decision.approvalPolicy,
        requiredScopes: definition?.requiredScopes ?? (definition?.requiredScope ? [definition.requiredScope] : []),
      };
    }),
    providerMessages,
  };
}
export const UNHANDLED_TOOL = Symbol('unhandled-ai-tool');

function planningRuntime() {
  return container.isRegistered(TOKENS.CommercialEdition)
    ? container.resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition).planning
    : undefined;
}

export function getPlanningSystemInstructions(): string {
  return planningRuntime()?.systemInstructions ?? '';
}
