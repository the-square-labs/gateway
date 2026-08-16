import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import OpenAI from 'openai';
import { container, TOKENS } from '@/container.js';
import { nodes as nodesTable } from '@/db/schema/nodes.js';
import { createChildLogger } from '@/lib/logger.js';
import {
  boundScopes,
  canManageUser,
  hasScope,
  hasScopeBase,
  hasScopeForResource,
  isScopeSubset,
} from '@/lib/permissions.js';
import { canonicalizeScopes } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AccessListService } from '@/modules/access-lists/access-list.service.js';
import { UpdateAuthProvisioningSettingsSchema } from '@/modules/admin/admin.schemas.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { getAuditRequestContext, setAuditMcpContext } from '@/modules/audit/audit-request-context.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import type { DatabaseConnectionService } from '@/modules/databases/databases.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import type { DomainsService } from '@/modules/domains/domain.service.js';
import type { GroupService } from '@/modules/groups/group.service.js';
import { LicenseService } from '@/modules/license/license.service.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import type { MonitoringService } from '@/modules/monitoring/monitoring.service.js';
import type { NodesService } from '@/modules/nodes/nodes.service.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import type { TemplatesService } from '@/modules/pki/templates.service.js';
import type { FolderService } from '@/modules/proxy/folder.service.js';
import { CreateNginxTemplateSchema, UpdateNginxTemplateSchema } from '@/modules/proxy/nginx-template.schemas.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { OutboundWebhookPolicyService } from '@/modules/settings/outbound-webhook-policy.service.js';
import { RequestACMECertSchema, SetSslAutoRenewSchema, UploadCertSchema } from '@/modules/ssl/ssl.schemas.js';
import type { SSLService } from '@/modules/ssl/ssl.service.js';
import { CreateTokenSchema, UpdateTokenSchema } from '@/modules/tokens/tokens.schemas.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { SchedulerService } from '@/services/scheduler.service.js';
import { UpdateService } from '@/services/update.service.js';
import type { User } from '@/types.js';
import { ACCESS_LIST_TOOL_NAMES, executeAccessListTool } from './ai.access-list-tools.js';
import { DATABASE_TOOL_NAMES, executeDatabaseTool } from './ai.database-tools.js';
import { manageDockerContainerConfigTool } from './ai.docker-config-tools.js';
import { DOCKER_TOOL_NAMES, executeDockerTool } from './ai.docker-tools.js';
import { getInternalDocumentation } from './ai.docs.js';
import { DOMAIN_TOOL_NAMES, executeDomainTool } from './ai.domain-tools.js';
import { executeFolderTool, FOLDER_TOOL_NAMES } from './ai.folder-tools.js';
import { executeGitLabTool, GITLAB_TOOL_NAMES } from './ai.gitlab-tools.js';
import { executeGroupTool, GROUP_TOOL_NAMES } from './ai.group-tools.js';
import { executeInferenceTool, INFERENCE_TOOL_NAMES } from './ai.inference-tools.js';
import { executeIntegrationTool, INTEGRATION_TOOL_NAMES } from './ai.integration-tools.js';
import { manageLoggingTool } from './ai.logging-tools.js';
import { executeNodeTool, NODE_TOOL_NAMES } from './ai.node-tools.js';
import { executeNotificationTool, NOTIFICATION_TOOL_NAMES } from './ai.notification-tools.js';
import { executePkiCaTool, PKI_CA_TOOL_NAMES } from './ai.pki-ca-tools.js';
import { executePkiCertificateTool, PKI_CERTIFICATE_TOOL_NAMES } from './ai.pki-certificate-tools.js';
import { executePkiTemplateTool, PKI_TEMPLATE_TOOL_NAMES } from './ai.pki-template-tools.js';
import { streamModelResponse } from './ai.provider-adapter.js';
import { executeProxyTool, PROXY_TOOL_NAMES } from './ai.proxy-tools.js';
import { findResource } from './ai.resource-search.js';
import { executeResourceSetupTool, RESOURCE_SETUP_TOOL_NAMES } from './ai.resource-setup-tools.js';
import type { AISandboxService } from './ai.sandbox.service.js';
import type { AISandboxArtifactService } from './ai.sandbox-artifact.service.js';
import {
  agentPage,
  agentPageLimit,
  allowedResourceIdsForScopes,
  compactProxyHostForAgent,
  dashboardStatsOptionsForScopes,
  getToolResourceId,
  hasToolExecutionScope,
  isMutatingTool,
  redactToolArgs,
} from './ai.service-helpers.js';
import type { AISettingsService } from './ai.settings.service.js';
import { AISkillService } from './ai.skills.js';
import { executeSshTool, SSH_TOOL_NAMES } from './ai.ssh-tools.js';
import { manageStatusPageTool } from './ai.status-page-tools.js';
import { buildAISystemPromptDetailed, type SystemPromptBreakdownItem } from './ai.system-prompt.js';
import {
  AI_TOOLS,
  getOpenAITools,
  inferDiscoveredToolsetsFromText,
  isBaseAIToolName,
  parseAndValidateAIToolArguments,
  TOOL_STORE_INVALIDATION_MAP,
  validateAIToolArguments,
} from './ai.tools.js';
import type {
  AIConfig,
  AIContextLimits,
  AIMessageAttachment,
  AIPlanRuntimeSnapshot,
  AIResourceReference,
  AIToolDefinition,
  ChatMessage,
  PageContext,
  ToolExecutionOptions,
  ToolExecutionResult,
  WSServerMessage,
} from './ai.types.js';
import { executeWebSearch } from './ai.web-search.js';
import { type AIApprovalMode, getAIToolApprovalDecision } from './ai-approval-policy.js';
import { directProviderContextLimits, toolOutputInlineLimits } from './ai-context-limits.js';
import { AIConversationService } from './ai-conversation.service.js';
import { type AIChatSearchScope, AIConversationSearchService } from './ai-conversation-search.service.js';
import type { AIPlanService } from './ai-plan.service.js';
import type { AIProviderRuntimeService, AIProviderSession } from './ai-provider-runtime.service.js';
import { appendAIResourceReferencesToModelResult, extractAIResourceReferences } from './ai-resource-references.js';
import { redactOneTimeSecretToolResult } from './ai-secret-result-redaction.js';
import {
  assertProviderInputWithinLimits,
  estimateProviderMessagesTokens,
  estimateTextTokens,
  estimateToolSchemaTokens,
} from './ai-token-estimator.js';

const logger = createChildLogger('AIService');
const SANDBOX_TOOL_NAMES = new Set([
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

type QueuedApproval = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type AutoCompactContextHook = (messages: ChatMessage[]) => Promise<ChatMessage[]>;
type ReceivePendingSteersHook = (messages: ChatMessage[]) => Promise<ChatMessage[]>;

type ToolRuntimeContext = {
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

const SEND_COMMENT_TOOL_NAME = 'send_comment';
const TOOL_COMMENT_REQUIRED_MESSAGE =
  'You have reached the maximum number of sequential tool-call rounds without a user-visible progress comment. Call only send_comment now with a concise, useful progress update. If this run already contains user-visible assistant text, use exactly the same language; otherwise use the response language selected for this run. Keep that language for every later comment and the final answer. Do not call any other tool in this response.';
const SEND_COMMENT_EMPTY_ERROR =
  'send_comment requires a real, non-empty progress comment for the user. Call send_comment again in the response language already selected for this run.';
const SEND_COMMENT_MIXED_ERROR =
  'send_comment must be called by itself. First send the progress comment, then call other tools in the next assistant turn.';
const RUN_LANGUAGE_LOCK_MESSAGE =
  'The response language for this run is now locked to the language of the first user-visible assistant text. Use that same language for every later progress update, question, and final answer in this run. Do not switch because tool results, documentation, or the original request use another language. Only a later user message explicitly requesting a language change may override this lock.';

function hasRunLanguageLock(messages: Array<{ role?: unknown; content?: unknown }>): boolean {
  return messages.some((message) => message.role === 'system' && message.content === RUN_LANGUAGE_LOCK_MESSAGE);
}

function ensureRuntimeLanguageLock(messages: ChatMessage[]): void {
  if (hasRunLanguageLock(messages)) return;
  messages.push({
    role: 'system',
    content: RUN_LANGUAGE_LOCK_MESSAGE,
    hiddenSystemEvent: true,
  });
}

function ensureProviderLanguageLock(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!hasRunLanguageLock(messages)) {
    messages.push({ role: 'system', content: RUN_LANGUAGE_LOCK_MESSAGE });
  }
  return messages;
}

function latestToolRoundHasUserVisibleAssistantText(messages: Record<string, unknown>[]): boolean {
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

const PLAN_LIFECYCLE_TOOL_NAMES = new Set([
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

function isToolNameAllowedForPlanState(toolName: string, status: AIPlanRuntimeSnapshot['status'] | null): boolean {
  if (!status) return !PLAN_LIFECYCLE_TOOL_NAMES.has(toolName) || toolName === 'enter_plan_mode';
  if (status === 'drafting') return !PLAN_LIFECYCLE_TOOL_NAMES.has(toolName) || toolName === 'submit_plan';
  if (status === 'validating') return !PLAN_LIFECYCLE_TOOL_NAMES.has(toolName) || toolName === 'submit_plan_review';
  if (status === 'awaiting_decision') {
    return (
      !PLAN_LIFECYCLE_TOOL_NAMES.has(toolName) || toolName === 'submit_plan' || toolName === 'start_plan_execution'
    );
  }
  if (status === 'executing') {
    return (
      !PLAN_LIFECYCLE_TOOL_NAMES.has(toolName) ||
      toolName === 'update_plan_step' ||
      toolName === 'pause_plan_execution' ||
      toolName === 'finalize_plan_execution'
    );
  }
  if (status === 'pause_requested') return false;
  if (status === 'paused') return toolName === 'resume_plan_execution';
  if (status === 'verifying')
    return (
      !PLAN_LIFECYCLE_TOOL_NAMES.has(toolName) ||
      toolName === 'pause_plan_execution' ||
      toolName === 'submit_plan_verification'
    );
  return !PLAN_LIFECYCLE_TOOL_NAMES.has(toolName);
}

function isToolAllowedForPlanState(
  tool: AIToolDefinition,
  status: AIPlanRuntimeSnapshot['status'] | null,
  args?: Record<string, unknown>
): boolean {
  if (!isToolNameAllowedForPlanState(tool.name, status)) return false;
  if (status === 'drafting' || status === 'validating' || status === 'verifying') {
    if (tool.planningAccess !== 'allowed') return false;
    if (!args || PLAN_LIFECYCLE_TOOL_NAMES.has(tool.name)) return true;
    const classification = getAIToolApprovalDecision(tool.name, 'normal', args).classification;
    return classification === 'read' || classification === 'system-never-ask';
  }
  return true;
}

export function shouldEndRunAfterPlanTool(toolName: string, result: unknown, error: string | undefined): boolean {
  if (error) return false;
  if (toolName === 'submit_plan_review') {
    return !isRecord(result) || result.requiresQuestion !== true;
  }
  if (
    toolName === 'enter_plan_mode' ||
    toolName === 'submit_plan' ||
    toolName === 'start_plan_execution' ||
    toolName === 'pause_plan_execution' ||
    toolName === 'resume_plan_execution' ||
    toolName === 'finalize_plan_execution'
  ) {
    return true;
  }
  return (
    toolName === 'submit_plan_verification' &&
    isRecord(result) &&
    result.status !== 'completed' &&
    result.completionPending !== true
  );
}

function buildPlanRuntimePrompt(plan: AIPlanRuntimeSnapshot): string {
  const planState = JSON.stringify({
    status: plan.status,
    goal: plan.goal,
    scope: plan.scope,
    assumptions: plan.assumptions,
    research: plan.research,
    verification: plan.verification,
    changeSummary: plan.changeSummary,
    validatorFindings:
      plan.intentReview?.verdict === 'revise' || plan.securityReview?.verdict === 'revise'
        ? [...(plan.intentReview?.findings ?? []), ...(plan.securityReview?.findings ?? [])]
        : [],
    steps: plan.steps.map((step) => ({
      title: step.title,
      status: step.status,
      verification: step.verification,
      evidence: step.evidence,
      skipReason: step.skipReason,
    })),
  });
  if (plan.status === 'drafting') {
    return `PLAN MODE is active. Clarify only material unknowns with ask_question, perform detailed research with planning-safe tools, and do not attempt any mutating action. Then call submit_plan with a complete structured plan. If validator findings are present, revise the plan to resolve them. Active plan: ${planState}`;
  }
  if (plan.status === 'validating') {
    return `You are the independent plan validator. Compare the draft with the user's intent and research, independently verify critical facts with planning-safe tools when needed, and call submit_plan_review. If the result says requiresQuestion:true, immediately call ask_question for the missing user decision before ending the run. Do not implement or change infrastructure. Active plan: ${planState}`;
  }
  if (plan.status === 'awaiting_decision') {
    return `A validated plan is published and available, but it does not put the conversation into a separate refinement state. Continue as a normal conversation. If and only if the user explicitly asks to execute, implement, proceed with, or resume this published plan, call start_plan_execution. If the user clearly requests changes to the plan, discuss or research them as needed and call submit_plan with the complete revised plan; do not change plan state merely because the user selected Refine in the UI or asked a question about it. For unrelated requests, answer or act normally under the current approval policy. Active plan: ${planState}`;
  }
  if (plan.status === 'executing') {
    return `Execute the accepted plan. Keep exactly one step in_progress and update every step through update_plan_step with verification evidence. User messages steer the execution. If they materially change scope, call pause_plan_execution with requiresRevision:true; the next planning run must publish a validated revision with changeSummary and wait for acceptance. Call finalize_plan_execution only when the goal is fully implemented and verified. Active plan: ${planState}`;
  }
  if (plan.status === 'pause_requested') {
    return `The user requested a pause. Finish only the already-started tool round and do not begin another model or tool round. Active plan: ${planState}`;
  }
  if (plan.status === 'paused') {
    return `The plan is paused. Use new user context to resolve the blocker, then call resume_plan_execution before continuing. Active plan: ${planState}`;
  }
  if (plan.status === 'verifying') {
    return `You are the independent final verifier. Use planning-safe read tools as needed, compare the implemented result and evidence with every accepted step, then call submit_plan_verification. Do not change infrastructure. When a passing result returns completionPending:true, provide the user-facing final response and end the turn without calling more tools; the plan becomes completed only after that turn finishes successfully. Active plan: ${planState}`;
  }
  return `An AI plan is active in state ${plan.status}. Do not start another plan. Active plan: ${planState}`;
}

function isAIResourceAppearanceColor(value: unknown): value is NonNullable<AIResourceReference['appearanceColor']> {
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
const SEND_COMMENT_REPAIR_LIMIT = 3;

type ModelTool = ReturnType<typeof getOpenAITools>[number];
type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
  parsedArgs: Record<string, unknown>;
  validationError?: string;
};

function isContextWindowError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null
        ? JSON.stringify(error)
        : String(error);
  return /context(?:_| )?(?:length|window)|maximum context|max(?:imum)? tokens|too many tokens/i.test(message);
}

function conversationEndReason(result: unknown, fallback: string): string {
  if (isRecord(result) && typeof result.reason === 'string' && result.reason.trim()) {
    return result.reason.trim();
  }
  return fallback;
}

function compactToolResultForModel(toolName: string, value: unknown): unknown {
  if (value == null) return value;
  const redactedValue = redactOneTimeSecretToolResult(toolName, value);
  if (redactedValue !== value) return redactedValue;
  if (toolName === 'send_artifact' && isRecord(value)) {
    const { artifactId, filename, mediaType, sizeBytes, sourcePath, downloadUrl } = value;
    return { artifactId, filename, mediaType, sizeBytes, sourcePath, downloadUrl };
  }
  return value;
}

function splitToolControlMetadata(
  toolName: string,
  value: unknown
): { modelVisible: unknown; clientAction?: Record<string, unknown> } {
  const compacted = compactToolResultForModel(toolName, value);
  if (!isRecord(compacted) || !isRecord(compacted.clientAction)) return { modelVisible: compacted };
  const { clientAction, ...modelVisible } = compacted;
  return { modelVisible, clientAction };
}

function toolOutputPreview(serialized: string): string {
  return serialized.length <= 2_048 ? serialized : `${serialized.slice(0, 2_048)}\n…`;
}

function createToolRoundStartEvent(
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

interface CompactionMessageUnit {
  start: number;
  end: number;
}

function compactionMessageUnits(messages: ChatMessage[]): CompactionMessageUnit[] {
  const units: CompactionMessageUnit[] = [];
  let index = 0;
  while (index < messages.length) {
    const start = index;
    if (messages[index]?.role === 'user') {
      index += 1;
      while (index < messages.length && messages[index]?.role !== 'user') index += 1;
      units.push({ start, end: index });
      continue;
    }
    if (messages[index]?.role === 'assistant' && messages[index]?.tool_calls?.length) {
      const callIds = new Set(messages[index].tool_calls?.map((call) => call.id));
      index += 1;
      while (index < messages.length && messages[index]?.role === 'tool') {
        const callId = messages[index]?.tool_call_id;
        if (callId && !callIds.has(callId)) break;
        index += 1;
      }
      units.push({ start, end: index });
      continue;
    }
    index += 1;
    units.push({ start, end: index });
  }
  return units;
}

function selectCompactionBoundary(
  messages: ChatMessage[],
  providerMessages: Record<string, unknown>[],
  recentBudget: number
): { source: ChatMessage[]; recent: ChatMessage[]; sourceTokens: number; recentTokens: number } {
  const units = compactionMessageUnits(messages);
  if (units.length <= 1) {
    return {
      source: [],
      recent: messages,
      sourceTokens: 0,
      recentTokens: estimateProviderMessagesTokens(providerMessages),
    };
  }

  let recentStart = units[units.length - 1].start;
  let recentTokens = estimateProviderMessagesTokens(providerMessages.slice(recentStart));
  for (let unitIndex = units.length - 2; unitIndex >= 0; unitIndex -= 1) {
    const candidateStart = units[unitIndex].start;
    const candidateTokens = estimateProviderMessagesTokens(providerMessages.slice(candidateStart));
    if (candidateTokens > recentBudget) break;
    recentStart = candidateStart;
    recentTokens = candidateTokens;
  }

  return {
    source: messages.slice(0, recentStart),
    recent: messages.slice(recentStart),
    sourceTokens: estimateProviderMessagesTokens(providerMessages.slice(0, recentStart)),
    recentTokens,
  };
}

function providerMessagesToClientMessages(messages: Record<string, unknown>[]): ChatMessage[] {
  return messages.map(providerMessageToClientMessage).filter((message): message is ChatMessage => message !== null);
}

function orderLatestToolRoundResults(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant' && Array.isArray(messages[index]?.tool_calls)) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return messages;
  const toolCalls = messages[assistantIndex].tool_calls as Array<{ id?: unknown }>;
  const order = toolCalls
    .map((call) => (typeof call.id === 'string' ? call.id : null))
    .filter((id): id is string => id !== null);
  if (order.length === 0) return messages;
  const suffix = messages.slice(assistantIndex + 1);
  const results = new Map(
    suffix
      .filter((message) => message.role === 'tool' && typeof message.tool_call_id === 'string')
      .map((message) => [message.tool_call_id as string, message])
  );
  if (order.some((id) => !results.has(id))) return messages;
  const nonResults = suffix.filter((message) => message.role !== 'tool' || typeof message.tool_call_id !== 'string');
  return [...messages.slice(0, assistantIndex + 1), ...order.map((id) => results.get(id)!), ...nonResults];
}

function providerMessageToClientMessage(message: Record<string, unknown>): ChatMessage | null {
  const role = message.role;
  if (role === 'system') {
    return message.content === RUN_LANGUAGE_LOCK_MESSAGE
      ? { role: 'system', content: RUN_LANGUAGE_LOCK_MESSAGE, hiddenSystemEvent: true }
      : null;
  }
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return null;
  const content = message.content;
  return {
    role,
    content: typeof content === 'string' ? content : content == null ? null : safeStringify(content),
    tool_calls: Array.isArray(message.tool_calls) ? (message.tool_calls as ChatMessage['tool_calls']) : undefined,
    tool_call_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined,
    name: typeof message.name === 'string' ? message.name : undefined,
  };
}

function serializeMessagesForCompaction(messages: ChatMessage[]): string {
  return messages
    .map((message, index) => {
      const heading = `#${index + 1} ${message.role}`;
      let content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      if (message.role === 'tool' && message.name) {
        try {
          const parsed = JSON.parse(content) as unknown;
          content = safeStringify(redactToolArgs(redactOneTimeSecretToolResult(message.name, parsed)));
        } catch {
          // Non-JSON legacy tool output has no structured keys to redact.
        }
      }
      const attachments = message.attachments?.length
        ? `\nAttachments: ${message.attachments.map((attachment) => attachment.filename).join(', ')}`
        : '';
      const toolCalls = message.tool_calls?.length
        ? `\nTool calls: ${message.tool_calls
            .map((toolCall) => {
              let args: unknown = {};
              try {
                args = JSON.parse(toolCall.function.arguments || '{}');
              } catch {
                args = {};
              }
              return `${toolCall.function.name}(${safeStringify(redactToolArgs(args))})`;
            })
            .join('\n')}`
        : '';
      return `${heading}\n${content}${attachments}${toolCalls}`;
    })
    .join('\n\n---\n\n');
}

function buildCompactionSystemPrompt(trigger: AIContextCompactionTrigger): string {
  return [
    'You compact Gateway AI chat history for future assistant turns.',
    'Write the summary in the same language as the conversation, especially the latest user messages.',
    'Preserve user goals, explicit constraints, decisions, accepted designs, current task state, open questions, important IDs, paths, commands, resources, and tool outcomes.',
    'Do not invent facts. Do not include raw one-time secrets, API tokens, passwords, private keys, or credential values; say that secret material was omitted when relevant.',
    trigger === 'auto'
      ? 'This compaction was triggered automatically because the active context was near the model limit.'
      : 'This compaction was triggered manually by the user.',
    'Return only the compacted summary, without prefacing it with meta commentary.',
  ].join('\n');
}

function buildCompactionUserPrompt(input: { sourceText: string; sourceMessageCount: number }): string {
  return [
    'Summarize all older chat context below. Newer complete turns and tool rounds are retained verbatim outside this request.',
    `Older message count: ${input.sourceMessageCount}.`,
    '',
    input.sourceText,
  ]
    .filter(Boolean)
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampIntegerValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function commentMessageFromArgs(args: Record<string, unknown>): string {
  const value = args.message;
  return typeof value === 'string' ? value.trim() : '';
}

function commentToolFrom(tools: ModelTool[]): ModelTool[] {
  return tools.filter((tool) => tool.function.name === SEND_COMMENT_TOOL_NAME);
}

function boolArg(value: unknown): boolean {
  return value === true;
}

function getEffectiveGroupScopes(group: { scopes?: string[]; inheritedScopes?: string[] }): string[] {
  return [...new Set([...(group.scopes ?? []), ...(group.inheritedScopes ?? [])])];
}

const AI_SETTINGS_UPDATE_FIELDS = new Set([
  'enabled',
  'providerType',
  'providerUrl',
  'endpointMode',
  'supportsImages',
  'apiKey',
  'model',
  'gatewayInferenceModel',
  'gatewayInferenceAllowUserModelSelection',
  'allowUserReasoningEffortSelection',
  'customSystemPrompt',
  'rateLimitMax',
  'rateLimitWindowSeconds',
  'maxToolRounds',
  'maxContextTokens',
  'maxCompletionTokens',
  'maxTokensField',
  'reasoningEffort',
  'disabledTools',
  'webSearchProvider',
  'webSearchBaseUrl',
  'webSearchApiKey',
  'sandboxEnabled',
  'sandboxDefaultTier',
]);

function aiSettingsUpdatesFromArgs(args: Record<string, unknown>): Record<string, unknown> {
  const updatesSource = isRecord(args.updates) ? args.updates : args;
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updatesSource)) {
    if (AI_SETTINGS_UPDATE_FIELDS.has(key)) updates[key] = value;
  }
  return updates;
}

function mergeToolsets(existing: string[], added: string[]): string[] {
  const source = added.length > 0 ? added : existing;
  return [...new Set(source.map((toolset) => toolset.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 3);
}

function rankToolCategories(
  tools: AIToolDefinition[],
  query = ''
): Array<{
  name: string;
  toolCount: number;
  matchingTools: string[];
}> {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9:_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  if (tokens.length === 0) return [];
  const byCategory = new Map<string, { score: number; tools: Set<string>; total: number }>();
  for (const tool of tools) {
    const entry = byCategory.get(tool.category) ?? { score: 0, tools: new Set<string>(), total: 0 };
    entry.total += 1;
    const category = tool.category.toLowerCase();
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();
    const scope = tool.requiredScope.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (category.includes(token)) score += 8;
      if (name.includes(token)) score += 6;
      if (description.includes(token)) score += 2;
      if (scope.includes(token)) score += 1;
    }
    if (score > 0) {
      entry.score += score;
      entry.tools.add(tool.name);
    }
    byCategory.set(tool.category, entry);
  }
  return [...byCategory.entries()]
    .filter(([, value]) => value.score > 0)
    .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))
    .map(([name, value]) => ({
      name,
      toolCount: value.total,
      matchingTools: [...value.tools].sort().slice(0, 5),
    }));
}

function latestCompactEpoch(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.compactMarker) return messages[index]?.compactEpoch ?? 0;
  }
  return 0;
}

function discoveredToolsetsFromResult(value: unknown): string[] | undefined {
  return isRecord(value) && Array.isArray(value.discoveredToolsets)
    ? value.discoveredToolsets.filter((toolset): toolset is string => typeof toolset === 'string')
    : undefined;
}

function inferDiscoveredToolsetsFromMessages(messages: ChatMessage[]): string[] {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  return typeof latestUserMessage?.content === 'string'
    ? inferDiscoveredToolsetsFromText(latestUserMessage.content)
    : [];
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '"[Undefined]"';
  } catch {
    return '"[Unserializable]"';
  }
}

function estimateToolBreakdown(
  tools: Array<{ function: { name: string } }>
): Array<{ label: string; chars: number; tokens: number }> {
  const toolDefinitionsByName = new Map(AI_TOOLS.map((tool) => [tool.name, tool]));
  const byCategory = new Map<string, { chars: number; tokens: number }>();
  for (const tool of tools) {
    const category = toolDefinitionsByName.get(tool.function.name)?.category ?? 'Other';
    const serialized = safeStringify(tool);
    const current = byCategory.get(category) ?? { chars: 0, tokens: 0 };
    current.chars += serialized.length;
    current.tokens += estimateTextTokens(serialized);
    byCategory.set(category, current);
  }
  return [...byCategory.entries()]
    .map(([label, value]) => ({ label, ...value }))
    .sort((left, right) => right.tokens - left.tokens);
}

function normalizeSearchScope(value: unknown): AIChatSearchScope | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  if (value.type === 'current_project' || value.type === 'no_project' || value.type === 'all_user_chats') {
    return { type: value.type };
  }
  if (value.type === 'project' && typeof value.projectId === 'string' && value.projectId.trim()) {
    return { type: 'project', projectId: value.projectId.trim() };
  }
  return undefined;
}

function normalizeReadChatSliceMode(value: unknown): 'latest' | 'first' | 'around_message' | 'after' | 'before' {
  return value === 'first' || value === 'around_message' || value === 'after' || value === 'before' ? value : 'latest';
}

const GITLAB_TOOL_ARG_SECRET_KEY_RE =
  /^(?:token|secret|password|value|privateKey|private_key|webhookSecret|webhook_secret)$/i;

function redactArgsForTool(toolName: string, args: Record<string, unknown>): unknown {
  const redacted = redactToolArgs(args);
  if (!toolName.startsWith('gitlab_')) return redacted;
  return redactGitLabToolArgs(redacted);
}

function approvalDisplayArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactArgsForTool(toolName, args);
  return isRecord(redacted) ? redacted : {};
}

function queuedApprovalDisplayArgs(approvals: QueuedApproval[]): QueuedApproval[] {
  return approvals.map((approval) => ({
    ...approval,
    arguments: approvalDisplayArgs(approval.name, approval.arguments),
    rawArguments: approval.arguments,
  }));
}

function redactGitLabToolArgs(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[REDACTED_DEPTH_LIMIT]';
  if (Array.isArray(value)) return value.map((item) => redactGitLabToolArgs(item, depth + 1));

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = GITLAB_TOOL_ARG_SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactGitLabToolArgs(nested, depth + 1);
  }
  return redacted;
}

export class AIService {
  private readonly roundInlineTokens = new Map<string, number>();
  constructor(
    private readonly settingsService: AISettingsService,
    private readonly caService: CAService,
    private readonly certService: CertService,
    private readonly templatesService: TemplatesService,
    private readonly proxyService: ProxyService,
    private readonly folderService: FolderService,
    private readonly sslService: SSLService,
    private readonly domainsService: DomainsService,
    private readonly accessListService: AccessListService,
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
    private readonly monitoringService: MonitoringService,
    private readonly nodesService: NodesService,
    private readonly groupService: GroupService,
    private readonly databaseService: DatabaseConnectionService,
    private readonly dockerService: DockerManagementService,
    private readonly notifRuleService?: import('@/modules/notifications/notification-alert-rule.service.js').NotificationAlertRuleService,
    private readonly notifWebhookService?: import('@/modules/notifications/notification-webhook.service.js').NotificationWebhookService,
    private readonly notifDeliveryService?: import('@/modules/notifications/notification-delivery.service.js').NotificationDeliveryService,
    private readonly notifDispatcherService?: import('@/modules/notifications/notification-dispatcher.service.js').NotificationDispatcherService,
    private readonly sandboxService?: AISandboxService,
    private readonly artifactService?: AISandboxArtifactService,
    private readonly conversationSearchService?: AIConversationSearchService,
    private readonly providerRuntimeService?: AIProviderRuntimeService,
    private readonly siemDestinationService?: import('@/modules/audit/siem-destination.service.js').SiemDestinationService,
    private readonly siemDeliveryService?: import('@/modules/audit/siem-delivery.service.js').SiemDeliveryService,
    private readonly generalSettingsService?: import('@/modules/settings/general-settings.service.js').GeneralSettingsService,
    private readonly planService?: AIPlanService,
    private readonly dockerSnapshotService?: DockerSnapshotService
  ) {}

  private async resolveCurrentApprovalMode(user: User): Promise<AIApprovalMode> {
    const refreshUser = this.authService?.getUserById?.bind(this.authService);
    if (!refreshUser) return user.aiApprovalMode ?? 'normal';

    try {
      const currentUser = await refreshUser(user.id);
      if (!currentUser || currentUser.isBlocked) return 'normal';
      return currentUser.aiApprovalMode ?? 'normal';
    } catch (error) {
      logger.warn('Failed to refresh AI approval mode before tool round; requiring normal approvals', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'normal';
    }
  }

  private async resolveProviderSession(
    user: User,
    options: Parameters<AIProviderRuntimeService['resolveSession']>[1]
  ): Promise<AIProviderSession> {
    if (this.providerRuntimeService) return this.providerRuntimeService.resolveSession(user, options);

    const config = await this.settingsService.getConfig();
    if (config.providerType === 'gateway_inference') {
      throw new AppError(503, 'AI_GATEWAY_INFERENCE_UNAVAILABLE', 'Gateway Inference runtime is unavailable');
    }
    const apiKey = await this.settingsService.getDecryptedApiKey();
    if (!apiKey)
      throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI is not configured. An admin must set up the API key.');
    const requestedReasoningEffort = options.requestedReasoningEffort?.trim();
    if (requestedReasoningEffort && !config.allowUserReasoningEffortSelection) {
      throw new AppError(403, 'AI_REASONING_EFFORT_SELECTION_DISABLED', 'Reasoning effort selection is disabled');
    }
    if (requestedReasoningEffort && !['default', 'low', 'medium', 'high'].includes(requestedReasoningEffort)) {
      throw new AppError(
        400,
        'AI_REASONING_EFFORT_UNAVAILABLE',
        'The selected reasoning effort is unavailable for this provider'
      );
    }
    const effectiveReasoningEffort =
      requestedReasoningEffort && requestedReasoningEffort !== 'default'
        ? (requestedReasoningEffort as AIConfig['reasoningEffort'])
        : config.reasoningEffort;
    const effectiveConfig = options.preferMinimumReasoning
      ? { ...config, reasoningEffort: 'none' as const }
      : { ...config, reasoningEffort: effectiveReasoningEffort };
    const client = new OpenAI({ apiKey, baseURL: config.providerUrl || undefined });
    return {
      config: effectiveConfig,
      contextLimits: directProviderContextLimits(effectiveConfig.maxContextTokens, effectiveConfig.maxCompletionTokens),
      reasoningEffort: effectiveConfig.reasoningEffort === 'none' ? null : effectiveConfig.reasoningEffort,
      stream: (messages, tools, streamOptions) =>
        streamModelResponse({
          client,
          config: streamOptions?.maxOutputTokens
            ? {
                ...effectiveConfig,
                maxCompletionTokens: Math.min(effectiveConfig.maxCompletionTokens, streamOptions.maxOutputTokens),
              }
            : effectiveConfig,
          messages,
          tools,
          signal: options.signal,
        }),
    };
  }

  private async getAdminInferenceModels() {
    return this.providerRuntimeService ? this.providerRuntimeService.adminModels() : [];
  }

  private async prepareToolOutput(input: {
    userId: string;
    conversationId?: string;
    sourceRunId: string;
    sourceToolCallId: string;
    toolName: string;
    result: unknown;
    error?: string;
    contextLimits: AIContextLimits;
    systemPrompt: string;
    tools: ModelTool[];
    resourceReferences?: AIResourceReference[];
  }): Promise<{
    modelResult: unknown;
    eventResult: unknown;
    error?: string;
    clientAction?: Record<string, unknown>;
    resourceReferences: AIResourceReference[];
  }> {
    const resourceReferences = input.resourceReferences ?? [];
    if (input.error) {
      const errorResult = { error: input.error };
      return { modelResult: errorResult, eventResult: undefined, error: input.error, resourceReferences: [] };
    }

    const { modelVisible, clientAction } = splitToolControlMetadata(input.toolName, input.result);
    const format: 'json' | 'text' = typeof modelVisible === 'string' ? 'text' : 'json';
    const serialized = format === 'text' ? (modelVisible as string) : safeStringify(modelVisible);
    const estimatedTokens = estimateTextTokens(serialized);
    const limits = toolOutputInlineLimits(
      input.contextLimits,
      estimateTextTokens(input.systemPrompt),
      estimateToolSchemaTokens(input.tools)
    );

    const currentRoundTokens = this.roundInlineTokens.get(input.sourceRunId) ?? 0;
    if (
      estimatedTokens <= limits.perToolInlineLimit &&
      currentRoundTokens + estimatedTokens <= limits.roundInlineLimit
    ) {
      this.roundInlineTokens.set(input.sourceRunId, currentRoundTokens + estimatedTokens);
      return {
        modelResult: appendAIResourceReferencesToModelResult(modelVisible, resourceReferences),
        eventResult: modelVisible,
        clientAction,
        resourceReferences,
      };
    }

    if (input.toolName === 'read_tool_output' || input.toolName === 'search_tool_output') {
      const error = `TOOL_OUTPUT_INLINE_LIMIT_EXCEEDED: This bounded artifact read/search result is ${estimatedTokens} estimated tokens, above the ${limits.perToolInlineLimit} token inline limit. Retry with a smaller limitBytes or maxMatches value.`;
      return { modelResult: { error }, eventResult: undefined, error, clientAction, resourceReferences: [] };
    }

    if (!this.artifactService || !input.conversationId) {
      const error =
        'TOOL_OUTPUT_OFFLOAD_UNAVAILABLE: This result is too large to place in context and no conversation artifact store is available. Retry with pagination or narrower filters.';
      return { modelResult: { error }, eventResult: undefined, error, clientAction, resourceReferences: [] };
    }

    try {
      const descriptor = await this.artifactService.saveToolOutput({
        userId: input.userId,
        conversationId: input.conversationId,
        sourceRunId: input.sourceRunId,
        sourceToolCallId: input.sourceToolCallId,
        format,
        estimatedTokens,
        preview: toolOutputPreview(serialized),
        buffer: Buffer.from(serialized, 'utf8'),
      });
      return {
        modelResult: appendAIResourceReferencesToModelResult(descriptor, resourceReferences),
        eventResult: descriptor,
        clientAction,
        resourceReferences,
      };
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'TOOL_OUTPUT_TOO_LARGE' || error.code === 'TOOL_OUTPUT_ARTIFACT_QUOTA_EXCEEDED')
      ) {
        const message = `${error.code}: ${error.message}`;
        return {
          modelResult: {
            error: {
              code: error.code,
              message: error.message,
              retry: 'Narrow, filter, or paginate the request. Do not repeat the same unbounded call.',
            },
          },
          eventResult: undefined,
          error: message,
          clientAction,
          resourceReferences: [],
        };
      }
      throw error;
    }
  }

  private async toolResourceReferences(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    error?: string
  ): Promise<AIResourceReference[]> {
    if (error) return [];
    let nodeSlug: string | undefined;
    let nodeLabel: string | undefined;
    let nodeAppearanceColor: AIResourceReference['appearanceColor'];
    const nodeId = typeof args.nodeId === 'string' ? args.nodeId : undefined;
    if (nodeId) {
      try {
        const node = await this.nodesService.get(nodeId);
        nodeSlug = typeof node.slug === 'string' ? node.slug : undefined;
        nodeLabel =
          (typeof node.displayName === 'string' && node.displayName.trim()) ||
          (typeof node.hostname === 'string' && node.hostname.trim()) ||
          nodeSlug;
        nodeAppearanceColor = isAIResourceAppearanceColor(node.appearanceColor) ? node.appearanceColor : undefined;
      } catch {
        // The resource result remains usable even when its parent node can no longer be resolved.
      }
    }
    const references = extractAIResourceReferences(toolName, args, result, {
      nodeSlug,
      nodeLabel,
      nodeAppearanceColor,
    });
    const unresolvedContainer = references.find(
      (reference) =>
        reference.type === 'docker_container' &&
        (reference.label === reference.resourceId || /^[a-f0-9]{12,64}$/i.test(reference.label))
    );
    const containerId = typeof args.containerId === 'string' ? args.containerId : undefined;
    if (!unresolvedContainer || !nodeId || !containerId) return references;
    try {
      const inspected = (await this.dockerService.inspectContainer(nodeId, containerId)) as Record<string, unknown>;
      const canonicalName = String(inspected.Name ?? inspected.name ?? '')
        .trim()
        .replace(/^\/+/, '');
      if (!canonicalName) return references;
      return extractAIResourceReferences(toolName, { ...args, containerName: canonicalName }, result, {
        nodeSlug,
        nodeLabel,
        nodeAppearanceColor,
      });
    } catch {
      return references;
    }
  }

  async buildSystemPrompt(user: User, pageContext?: PageContext, conversationId?: string): Promise<string> {
    return (await this.buildSystemPromptDetailed(user, pageContext, conversationId)).prompt;
  }

  private async buildSystemPromptDetailed(
    user: User,
    pageContext?: PageContext,
    conversationId?: string
  ): Promise<{ prompt: string; breakdown: SystemPromptBreakdownItem[] }> {
    const retrievalPointers = conversationId
      ? await (this.conversationSearchService ?? container.resolve(AIConversationSearchService))
          .getPromptPointers(user.id, conversationId)
          .catch((error) => {
            logger.warn('Failed to build AI conversation retrieval pointers', {
              conversationId,
              error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
          })
      : undefined;
    const base = await buildAISystemPromptDetailed(
      {
        settingsService: this.settingsService,
        monitoringService: this.monitoringService,
        caService: this.caService,
        retrievalPointers,
      },
      user,
      pageContext
    );
    const activePlan = conversationId ? await this.planService?.getActivePlanSnapshot(user.id, conversationId) : null;
    if (!activePlan) return base;
    const planPrompt = buildPlanRuntimePrompt(activePlan);
    return {
      prompt: `${base.prompt}\n\n${planPrompt}`,
      breakdown: [
        ...base.breakdown,
        { label: 'Active plan', chars: planPrompt.length, tokens: estimateTextTokens(planPrompt) },
      ],
    };
  }

  async executeTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    options: ToolExecutionOptions = {}
  ): Promise<ToolExecutionResult> {
    const toolDef = AI_TOOLS.find((t) => t.name === toolName);
    if (!toolDef) {
      return { error: `Unknown tool: ${toolName}`, invalidateStores: [] };
    }

    const activePlan =
      options.source !== 'mcp' && options.conversationId && this.planService
        ? await this.planService.getActivePlanSnapshot(user.id, options.conversationId)
        : null;
    if (!isToolAllowedForPlanState(toolDef, activePlan?.status ?? null, args)) {
      return {
        error: `PLAN_MODE_BLOCKED: ${toolName} is unavailable while the active plan is ${activePlan?.status ?? 'inactive'}.`,
        invalidateStores: [],
      };
    }

    let executionUser: User;
    const refreshUser = this.authService?.getUserById?.bind(this.authService);
    if (!refreshUser) {
      // Lightweight unit-test service constructors may omit AuthService; production DI always supplies it.
      executionUser = options.scopes ? { ...user, scopes: options.scopes } : user;
    } else {
      try {
        const currentUser = await refreshUser(user.id);
        if (!currentUser || currentUser.isBlocked) {
          return {
            error: 'PERMISSION_DENIED: Your current account access no longer allows this action.',
            invalidateStores: [],
          };
        }
        executionUser =
          options.source === 'mcp'
            ? { ...currentUser, scopes: boundScopes(options.scopes ?? [], currentUser.scopes) }
            : currentUser;
      } catch (error) {
        logger.warn('Failed to refresh current access before AI tool execution', { userId: user.id, error });
        return {
          error: 'PERMISSION_DENIED: Current account access could not be verified.',
          invalidateStores: [],
        };
      }
    }

    // Permission check — tools with empty requiredScope are blocked (must be explicit)
    if (!hasToolExecutionScope(executionUser.scopes, toolName, toolDef.requiredScope, args, toolDef)) {
      return {
        error: `PERMISSION_DENIED: You do not have the "${toolDef.requiredScope || 'unknown'}" scope required for this action. Tell the user they lack this permission and suggest contacting an administrator. Do NOT ask follow-up questions or retry.`,
        invalidateStores: [],
      };
    }

    const source = options.source ?? 'ai';
    const shouldAudit = isMutatingTool(toolDef);
    const redactedArgs = redactArgsForTool(toolName, args);
    const mcpDetails =
      source === 'mcp'
        ? {
            toolName,
            category: toolDef.category,
            arguments: redactedArgs as Record<string, unknown>,
            tokenId: options.tokenId,
            tokenPrefix: options.tokenPrefix,
            authType: options.authType,
            clientId: options.clientId,
          }
        : undefined;
    if (mcpDetails) setAuditMcpContext(mcpDetails);
    const auditWasEmitted = getAuditRequestContext()?.auditEmitted ?? false;
    const auditEmittedDuringTool = () => !auditWasEmitted && Boolean(getAuditRequestContext()?.auditEmitted);
    const auditBase = {
      userId: user.id,
      resourceType: toolDef.category.toLowerCase().replace(/\s+/g, '_'),
      resourceId: getToolResourceId(toolDef, args),
    };

    try {
      const result = await this.executeToolInternal(executionUser, toolName, args, {
        pageContext: options.pageContext,
        conversationId: options.conversationId,
      });
      const invalidateStores = TOOL_STORE_INVALIDATION_MAP[toolName] || [];
      await this.persistToolRuntimeState(user, options, toolName, result);

      if (source === 'mcp' && !auditEmittedDuringTool()) {
        await this.auditService.log({
          ...auditBase,
          action: `mcp.${toolName}`,
          details: { ...mcpDetails, source: 'mcp', success: true },
        });
      } else if (source === 'ai' && shouldAudit) {
        await this.auditService.log({
          ...auditBase,
          action: `${source}.${toolName}`,
          details: { ai_initiated: true, arguments: redactedArgs },
        });
      }

      return { result, invalidateStores };
    } catch (err) {
      if (
        source === 'ai' &&
        err instanceof AppError &&
        ['GITLAB_CREDENTIAL_REQUIRED', 'GITHUB_CREDENTIAL_REQUIRED', 'GIT_CREDENTIAL_REQUIRED'].includes(err.code)
      ) {
        const details = isRecord(err.details) ? err.details : {};
        const provider = details.provider ?? (err.code === 'GITLAB_CREDENTIAL_REQUIRED' ? 'gitlab' : null);
        if (
          typeof details.connectorId === 'string' &&
          (provider === 'gitlab' || provider === 'github' || provider === 'git')
        ) {
          return {
            credentialChallenge: { provider, connectorId: details.connectorId },
            invalidateStores: [],
          };
        }
      }
      const message = err instanceof Error ? err.message : 'Tool execution failed';
      logger.error(`Tool execution failed: ${toolName}`, { error: err, args: redactArgsForTool(toolName, args) });
      if (source === 'mcp' && !auditEmittedDuringTool()) {
        await this.auditService.log({
          ...auditBase,
          action: `mcp.${toolName}`,
          details: {
            ...mcpDetails,
            source: 'mcp',
            success: false,
            error: message,
          },
        });
      }
      return { error: message, invalidateStores: [] };
    }
  }

  private async executeSandboxTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext
  ) {
    const config = await this.settingsService.getConfig();
    if (!config.sandboxEnabled) {
      throw new Error('Sandbox runner is disabled');
    }
    if (!this.sandboxService) {
      throw new Error('Sandbox runner is not configured');
    }
    const a = args as Record<string, unknown>;
    const resourceTier = (a.resourceTier ?? config.sandboxDefaultTier) as never;
    switch (toolName) {
      case 'execute_script':
        return this.sandboxService.executeScript(user, {
          runtime: a.runtime,
          script: String(a.script ?? ''),
          resourceTier,
          ttlSeconds: typeof a.ttlSeconds === 'number' ? a.ttlSeconds : undefined,
          conversationId: runtimeContext.conversationId,
        });
      case 'run_process':
        return this.sandboxService.runProcess(user, {
          runtime: a.runtime,
          command: Array.isArray(a.command) ? a.command.map(String) : [],
          resourceTier,
          ttlSeconds: typeof a.ttlSeconds === 'number' ? a.ttlSeconds : undefined,
          conversationId: runtimeContext.conversationId,
        });
      case 'fetch':
        return this.sandboxService.fetch(user, { url: String(a.url ?? '') });
      case 'download_artifact':
        return this.sandboxService.downloadArtifact(user, {
          processId: String(a.processId ?? ''),
          url: String(a.url ?? ''),
          path: typeof a.path === 'string' ? a.path : undefined,
        });
      case 'list_artifact_files':
        return this.sandboxService.listArtifactFiles(user, {
          processId: String(a.processId ?? ''),
          path: typeof a.path === 'string' ? a.path : undefined,
          maxDepth: typeof a.maxDepth === 'number' ? a.maxDepth : undefined,
          limit: typeof a.limit === 'number' ? a.limit : undefined,
          includeFiles: typeof a.includeFiles === 'boolean' ? a.includeFiles : undefined,
          includeDirectories: typeof a.includeDirectories === 'boolean' ? a.includeDirectories : undefined,
        });
      case 'read_artifact':
        return this.sandboxService.readArtifact(user, {
          processId: String(a.processId ?? ''),
          path: String(a.path ?? ''),
          offset: typeof a.offset === 'number' ? a.offset : undefined,
          length: typeof a.length === 'number' ? a.length : undefined,
          encoding: a.encoding === 'base64' ? 'base64' : 'utf8',
        });
      case 'send_artifact':
        return this.sandboxService.sendArtifact(user, {
          processId: String(a.processId ?? ''),
          path: String(a.path ?? ''),
          filename: typeof a.filename === 'string' ? a.filename : undefined,
          mediaType: typeof a.mediaType === 'string' ? a.mediaType : undefined,
          conversationId: runtimeContext.conversationId,
        });
      case 'read_process_output':
        return this.sandboxService.readProcessOutput(
          user,
          String(a.processId ?? ''),
          typeof a.tail === 'number' ? a.tail : undefined
        );
      case 'write_process_stdin':
        return this.sandboxService.writeProcessStdin(
          user,
          String(a.processId ?? ''),
          String(a.data ?? ''),
          a.close === true
        );
      case 'kill_process':
        return this.sandboxService.killProcess(user, String(a.processId ?? ''));
      case 'list_sandbox_jobs':
        return this.sandboxService.listJobs(user, {
          activeOnly: a.activeOnly === true,
          limit: typeof a.limit === 'number' ? a.limit : undefined,
        });
      default:
        throw new Error(`Unsupported sandbox tool: ${toolName}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async executeToolInternal(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext = {}
  ): Promise<unknown> {
    // Tool args come from LLM JSON — use explicit casts to match service input types.
    // The services themselves validate the data, so loose typing here is acceptable.
    const a = args as any; // shorthand for repeated casts

    if (toolName === 'read_tool_output' || toolName === 'search_tool_output') {
      if (!this.artifactService || !runtimeContext.conversationId) {
        throw new AppError(
          409,
          'TOOL_OUTPUT_CONTEXT_REQUIRED',
          'Tool-output artifacts can only be accessed from their originating conversation'
        );
      }
      if (toolName === 'read_tool_output') {
        return this.artifactService.readToolOutput({
          userId: user.id,
          conversationId: runtimeContext.conversationId,
          artifactId: String(a.artifactId ?? ''),
          offset: typeof a.offset === 'number' ? a.offset : undefined,
          limitBytes: typeof a.limitBytes === 'number' ? a.limitBytes : undefined,
        });
      }
      return this.artifactService.searchToolOutput({
        userId: user.id,
        conversationId: runtimeContext.conversationId,
        artifactId: String(a.artifactId ?? ''),
        query: String(a.query ?? ''),
        maxMatches: typeof a.maxMatches === 'number' ? a.maxMatches : undefined,
      });
    }

    if (DATABASE_TOOL_NAMES.has(toolName)) {
      return executeDatabaseTool({ databaseService: this.databaseService }, user, toolName, args);
    }
    if (INFERENCE_TOOL_NAMES.has(toolName)) {
      return executeInferenceTool(user, toolName, args);
    }
    if (INTEGRATION_TOOL_NAMES.has(toolName)) {
      return executeIntegrationTool(user, toolName, args);
    }
    if (RESOURCE_SETUP_TOOL_NAMES.has(toolName)) {
      return executeResourceSetupTool(user, toolName, args);
    }
    if (DOCKER_TOOL_NAMES.has(toolName)) {
      return executeDockerTool(
        {
          dockerService: this.dockerService,
          ensureToolScope: (executionUser, scope) => this.ensureToolScope(executionUser, scope),
          ensureToolScopeForResource: (executionUser, baseScope, resourceId) =>
            this.ensureToolScopeForResource(executionUser, baseScope, resourceId),
        },
        user,
        toolName,
        args
      );
    }
    if (NOTIFICATION_TOOL_NAMES.has(toolName)) {
      return executeNotificationTool(
        {
          notifRuleService: this.notifRuleService,
          notifWebhookService: this.notifWebhookService,
          notifDeliveryService: this.notifDeliveryService,
          notifDispatcherService: this.notifDispatcherService,
          siemDestinationService: this.siemDestinationService,
          siemDeliveryService: this.siemDeliveryService,
          generalSettingsService: this.generalSettingsService,
        },
        user,
        toolName,
        args
      );
    }
    if (SANDBOX_TOOL_NAMES.has(toolName)) {
      return this.executeSandboxTool(user, toolName, args, runtimeContext);
    }
    if (GITLAB_TOOL_NAMES.has(toolName)) {
      return executeGitLabTool(
        {
          sandboxService: this.sandboxService,
          conversationId: runtimeContext.conversationId,
        },
        user,
        toolName,
        args
      );
    }
    if (SSH_TOOL_NAMES.has(toolName)) {
      return executeSshTool(user, toolName, args);
    }
    if (FOLDER_TOOL_NAMES.has(toolName)) {
      return executeFolderTool(user, toolName, args);
    }
    if (NODE_TOOL_NAMES.has(toolName)) {
      return executeNodeTool(
        { nodesService: this.nodesService, getDispatchService: () => container.resolve(NodeDispatchService) },
        user,
        toolName,
        args
      );
    }
    if (GROUP_TOOL_NAMES.has(toolName)) {
      return executeGroupTool({ groupService: this.groupService }, user, toolName, args);
    }
    if (DOMAIN_TOOL_NAMES.has(toolName)) {
      return executeDomainTool(
        {
          domainsService: this.domainsService,
          ensureToolScopeForResource: (executionUser, baseScope, resourceId) =>
            this.ensureToolScopeForResource(executionUser, baseScope, resourceId),
        },
        user,
        toolName,
        args
      );
    }
    if (ACCESS_LIST_TOOL_NAMES.has(toolName)) {
      return executeAccessListTool(
        {
          accessListService: this.accessListService,
          ensureToolScopeForResource: (executionUser, baseScope, resourceId) =>
            this.ensureToolScopeForResource(executionUser, baseScope, resourceId),
        },
        user,
        toolName,
        args
      );
    }
    if (PKI_TEMPLATE_TOOL_NAMES.has(toolName)) {
      return executePkiTemplateTool(
        {
          templatesService: this.templatesService,
          ensureToolScope: (executionUser, scope) => this.ensureToolScope(executionUser, scope),
          ensureToolScopeForResource: (executionUser, baseScope, resourceId) =>
            this.ensureToolScopeForResource(executionUser, baseScope, resourceId),
        },
        user,
        toolName,
        args
      );
    }
    if (PKI_CA_TOOL_NAMES.has(toolName)) {
      return executePkiCaTool({ caService: this.caService }, user, toolName, args);
    }
    if (PKI_CERTIFICATE_TOOL_NAMES.has(toolName)) {
      return executePkiCertificateTool(
        {
          caService: this.caService,
          certService: this.certService,
          ensureToolScope: (executionUser, scope) => this.ensureToolScope(executionUser, scope),
          ensureToolScopeForResource: (executionUser, baseScope, resourceId) =>
            this.ensureToolScopeForResource(executionUser, baseScope, resourceId),
        },
        user,
        toolName,
        args
      );
    }
    if (PROXY_TOOL_NAMES.has(toolName)) {
      return executeProxyTool(
        { proxyService: this.proxyService, folderService: this.folderService },
        user,
        toolName,
        args
      );
    }

    switch (toolName) {
      // ── Discovery ──
      case 'discover_tools':
        return this.discoverTools(user, args, runtimeContext.conversationId);

      case 'read_skill': {
        const skillId = stringArg(a.skillId);
        if (!skillId) throw new AppError(400, 'AI_SKILL_ID_REQUIRED', 'skillId is required');
        const skill = await new AISkillService(this.settingsService).getRuntimeSkill(skillId);
        return { skill, active: false, nextStep: 'Call activate_skill before applying this skill.' };
      }

      case 'activate_skill': {
        const skillId = stringArg(a.skillId);
        if (!skillId) throw new AppError(400, 'AI_SKILL_ID_REQUIRED', 'skillId is required');
        const skill = await new AISkillService(this.settingsService).getRuntimeSkill(skillId);
        return {
          active: true,
          activationScope: 'current_context',
          priority: skill.source === 'system' ? 'system_skill' : 'organization_skill',
          skill,
          instruction:
            'Apply the activated instructions while they remain in the current context. Do not activate this skill again until compaction removes this activation. Base security, authorization, permission, and approval rules always take priority.',
        };
      }

      case 'get_current_context':
        return {
          currentPage: runtimeContext.pageContext ?? null,
          hasCurrentPage: !!runtimeContext.pageContext?.route,
        };

      case 'wait': {
        const rawSeconds = Number(a.seconds ?? 5);
        const seconds = Math.min(30, Math.max(1, Number.isFinite(rawSeconds) ? rawSeconds : 5));
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        return {
          waitedSeconds: seconds,
          reason: stringArg(a.reason) ?? null,
          nextStep: 'Call the relevant read/status tool again to verify whether the pending operation completed.',
        };
      }

      case SEND_COMMENT_TOOL_NAME: {
        const message = commentMessageFromArgs(args);
        if (!message) throw new Error(SEND_COMMENT_EMPTY_ERROR);
        return { delivered: true, message };
      }

      case 'end_conversation': {
        const reason = String(a.reason ?? '').trim();
        return {
          ended: true,
          reason: reason || 'This conversation has been ended.',
        };
      }

      case 'find_resource':
        return this.searchResources(user, args, runtimeContext);
      case 'search_chats':
        return (this.conversationSearchService ?? container.resolve(AIConversationSearchService)).searchChats(user.id, {
          query: String(a.query ?? ''),
          scope: normalizeSearchScope(a.scope),
          limit: typeof a.limit === 'number' ? a.limit : undefined,
          currentConversationId: runtimeContext.conversationId,
        });
      case 'search_compacted_history': {
        if (!runtimeContext.conversationId) {
          throw new AppError(
            409,
            'AI_CONVERSATION_REQUIRED',
            'search_compacted_history requires the current saved conversation'
          );
        }
        return (
          this.conversationSearchService ?? container.resolve(AIConversationSearchService)
        ).searchCompactedHistory(user.id, {
          conversationId: runtimeContext.conversationId,
          query: String(a.query ?? ''),
          limit: typeof a.limit === 'number' ? a.limit : undefined,
        });
      }
      case 'find_in_chat':
        return (this.conversationSearchService ?? container.resolve(AIConversationSearchService)).findInChat(user.id, {
          conversationId: String(a.conversationId ?? ''),
          query: String(a.query ?? ''),
          limit: typeof a.limit === 'number' ? a.limit : undefined,
          currentConversationId: runtimeContext.conversationId,
        });
      case 'read_chat_slice':
        return (this.conversationSearchService ?? container.resolve(AIConversationSearchService)).readChatSlice(
          user.id,
          {
            conversationId: String(a.conversationId ?? ''),
            mode: normalizeReadChatSliceMode(a.mode),
            messageId: typeof a.messageId === 'string' ? a.messageId : undefined,
            cursor: typeof a.cursor === 'string' ? a.cursor : undefined,
            limit: typeof a.limit === 'number' ? a.limit : undefined,
            currentConversationId: runtimeContext.conversationId,
          }
        );
      case 'list_chat_projects':
        return (this.conversationSearchService ?? container.resolve(AIConversationSearchService)).listProjects(
          user.id,
          {
            limit: typeof a.limit === 'number' ? a.limit : undefined,
            cursor: typeof a.cursor === 'string' ? a.cursor : undefined,
            currentConversationId: runtimeContext.conversationId,
          }
        );

      case 'manage_proxy_template': {
        const { NginxTemplateService } = await import('@/modules/proxy/nginx-template.service.js');
        const templateService = container.resolve(NginxTemplateService);
        if (a.operation === 'list') {
          this.ensureToolScope(user, 'proxy:templates:view');
          return templateService.listTemplates({
            allowedIds: allowedResourceIdsForScopes(user.scopes, 'proxy:templates:view'),
          });
        }
        if (a.operation === 'get') {
          this.ensureToolScopeForResource(user, 'proxy:templates:view', String(a.templateId));
          return templateService.getTemplate(a.templateId);
        }
        if (a.operation === 'create') {
          this.ensureToolScope(user, 'proxy:templates:create');
          return templateService.createTemplate(CreateNginxTemplateSchema.parse(args), user.id);
        }
        if (a.operation === 'update') {
          this.ensureToolScopeForResource(user, 'proxy:templates:edit', String(a.templateId));
          return templateService.updateTemplate(a.templateId, UpdateNginxTemplateSchema.parse(args), user.id);
        }
        if (a.operation === 'delete') {
          this.ensureToolScopeForResource(user, 'proxy:templates:delete', String(a.templateId));
          await templateService.deleteTemplate(a.templateId, user.id);
          return { success: true };
        }
        if (a.operation === 'clone') {
          this.ensureToolScopeForResource(user, 'proxy:templates:edit', String(a.templateId));
          this.ensureToolScope(user, 'proxy:templates:create');
          return templateService.cloneTemplate(a.templateId, user.id);
        }
        throw new Error(`Unsupported proxy template operation: ${String(a.operation)}`);
      }

      // ── SSL Certificates ──
      case 'list_ssl_certificates':
        return this.sslService.listCerts(
          { search: a.search, page: agentPage(a.page), limit: agentPageLimit(a.limit) },
          { allowedIds: allowedResourceIdsForScopes(user.scopes, 'ssl:cert:view') }
        );
      case 'link_internal_cert':
        return this.sslService.linkInternalCert({ internalCertId: a.internalCertId, name: a.name }, user.id);
      case 'request_acme_cert':
        return this.sslService.requestACMECert(RequestACMECertSchema.parse(args), user.id, user.email);
      case 'manage_ssl_certificate': {
        if (a.operation === 'get') {
          this.ensureToolScopeForResource(user, 'ssl:cert:view', String(a.sslCertificateId));
          return this.sslService.getCert(a.sslCertificateId);
        }
        if (a.operation === 'upload') {
          this.ensureToolScope(user, 'ssl:cert:issue');
          return this.sslService.uploadCert(UploadCertSchema.parse(args), user.id);
        }
        if (a.operation === 'renew') {
          this.ensureToolScopeForResource(user, 'ssl:cert:issue', String(a.sslCertificateId));
          return this.sslService.renewCert(a.sslCertificateId, user.id);
        }
        if (a.operation === 'verify_dns') {
          this.ensureToolScopeForResource(user, 'ssl:cert:issue', String(a.sslCertificateId));
          return this.sslService.completeDNS01Verification(a.sslCertificateId, user.id);
        }
        if (a.operation === 'set_auto_renew') {
          this.ensureToolScopeForResource(user, 'ssl:cert:issue', String(a.sslCertificateId));
          return this.sslService.setAutoRenew(a.sslCertificateId, SetSslAutoRenewSchema.parse(args), user.id);
        }
        if (a.operation === 'delete') {
          this.ensureToolScopeForResource(user, 'ssl:cert:delete', String(a.sslCertificateId));
          await this.sslService.deleteCert(a.sslCertificateId, user.id);
          return { success: true };
        }
        throw new Error(`Unsupported SSL certificate operation: ${String(a.operation)}`);
      }

      // ── Raw Config ──
      case 'get_proxy_rendered_config': {
        const host = await this.proxyService.getProxyHost(a.proxyHostId);
        if (!host) throw new Error('Route not found');
        const renderedConfig = await this.proxyService.getRenderedConfig(a.proxyHostId);
        return { proxyHostId: a.proxyHostId, config: renderedConfig };
      }
      case 'update_proxy_raw_config': {
        const rawHost = await this.proxyService.getProxyHost(a.proxyHostId);
        if (!rawHost) throw new Error('Route not found');
        if (!(rawHost as any).rawConfigEnabled) {
          throw new Error('Raw mode is not enabled on this route. Enable it first with toggle_proxy_raw_mode.');
        }
        const bypassRawValidation = hasScope(user.scopes, `proxy:raw:bypass:${a.proxyHostId}`);
        return compactProxyHostForAgent(
          await this.proxyService.updateProxyHost(a.proxyHostId, { rawConfig: a.rawConfig } as any, user.id, {
            bypassRawValidation,
          })
        );
      }
      case 'toggle_proxy_raw_mode': {
        const bypassRawValidation = hasScope(user.scopes, `proxy:raw:bypass:${a.proxyHostId}`);
        return compactProxyHostForAgent(
          await this.proxyService.updateProxyHost(a.proxyHostId, { rawConfigEnabled: a.enabled } as any, user.id, {
            bypassRawValidation,
          })
        );
      }

      // ── Administration ──
      case 'list_users':
        return this.authService.listUsers();
      case 'create_user': {
        const destGroup = await this.groupService.getGroup(a.groupId);
        if (!isScopeSubset(getEffectiveGroupScopes(destGroup), user.scopes)) {
          throw new Error('Cannot assign a group with permissions you do not possess');
        }
        return this.authService.createUser({
          email: a.email,
          name: a.name,
          groupId: a.groupId,
        });
      }
      case 'update_user_role': {
        if (a.userId === user.id) {
          throw new Error('Cannot change your own group');
        }
        const targetUser = await this.authService.getUserById(a.userId);
        if (!targetUser) throw new Error('User not found');
        if (targetUser.isDeleted) throw new Error('Deleted users must be restored before they can be changed');
        if (targetUser.oidcSubject?.startsWith('system:')) {
          throw new Error('Cannot modify the system user');
        }
        await this.authService.assertCanUpdateUserGroup(user.id, user.scopes, a.userId, a.groupId);
        return this.authService.updateUserGroup(a.userId, a.groupId);
      }
      case 'set_user_additional_permissions': {
        if (
          !Array.isArray(a.additionalScopes) ||
          a.additionalScopes.some((scope: unknown) => typeof scope !== 'string')
        ) {
          throw new Error('additionalScopes must be an array of permission scope strings');
        }
        const requestedScopes = a.additionalScopes as string[];
        const { additionalScopes } = await this.authService.assertCanUpdateUserAdditionalScopes(
          user.id,
          user.scopes,
          a.userId,
          requestedScopes
        );
        return this.authService.updateUserAdditionalScopes(a.userId, additionalScopes);
      }
      case 'set_user_blocked': {
        if (a.userId === user.id) {
          throw new Error('Cannot block yourself');
        }
        const targetUser = await this.authService.getUserById(a.userId);
        if (!targetUser) throw new Error('User not found');
        if (targetUser.isDeleted) throw new Error('Deleted users must be restored before they can be changed');
        if (targetUser.oidcSubject?.startsWith('system:')) {
          throw new Error('Cannot modify the system user');
        }
        const denyReason = canManageUser(user.scopes, targetUser.scopes);
        if (denyReason) throw new Error(denyReason);
        return a.blocked ? this.authService.blockUser(a.userId) : this.authService.unblockUser(a.userId);
      }
      case 'delete_user': {
        if (a.userId === user.id) {
          throw new Error('Cannot delete your own account');
        }
        const targetUser = await this.authService.getUserById(a.userId);
        if (!targetUser) throw new Error('User not found');
        if (targetUser.isDeleted) throw new Error('User is already deleted');
        if (targetUser.oidcSubject?.startsWith('system:')) {
          throw new Error('Cannot delete the system user');
        }
        const denyReason = canManageUser(user.scopes, targetUser.scopes);
        if (denyReason) throw new Error(denyReason);
        await this.authService.deleteUser(a.userId, user.id);
        return { success: true };
      }
      case 'get_ai_settings': {
        const [config, gatewayInferenceModels] = await Promise.all([
          this.settingsService.getConfigForAdmin(),
          this.getAdminInferenceModels(),
        ]);
        return { ...config, gatewayInferenceModels };
      }
      case 'update_ai_settings': {
        const updates = aiSettingsUpdatesFromArgs(args);
        if (Object.keys(updates).length === 0) {
          throw new Error('No supported AI settings fields were provided');
        }
        await this.settingsService.updateConfig(updates);
        const [config, gatewayInferenceModels] = await Promise.all([
          this.settingsService.getConfigForAdmin(),
          this.getAdminInferenceModels(),
        ]);
        return { ...config, gatewayInferenceModels };
      }
      case 'list_ai_tools':
        return AI_TOOLS.map((tool) => ({
          name: tool.name,
          category: tool.category,
          description: tool.description,
          destructive: tool.destructive,
          requiredScope: tool.requiredScope,
          invalidateStores: tool.invalidateStores,
        }));
      case 'get_sandbox_runtime_status': {
        const config = await this.settingsService.getConfig();
        const status = this.sandboxService?.status() ?? { status: 'unconfigured' };
        const health = this.sandboxService
          ? await this.sandboxService.health().catch((error) => ({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }))
          : { ok: false, error: 'Sandbox runner is not configured' };
        return {
          enabled: config.sandboxEnabled,
          defaultTier: config.sandboxDefaultTier,
          status,
          health,
        };
      }
      case 'manage_ai_conversation': {
        const conversationService = container.resolve(AIConversationService);
        const operation = String(a.operation ?? '');
        switch (operation) {
          case 'list':
            return conversationService.listConversations(user.id);
          case 'get': {
            const conversationId = String(a.conversationId ?? '');
            if (!conversationId) throw new Error('conversationId is required');
            const conversation = await conversationService.getConversation(user.id, conversationId);
            if (!conversation) throw new Error('Conversation not found');
            return conversation;
          }
          case 'delete': {
            const conversationId = String(a.conversationId ?? '');
            if (!conversationId) throw new Error('conversationId is required');
            const deleted = await conversationService.deleteConversation(user.id, conversationId);
            if (!deleted) throw new Error('Conversation not found');
            return { deleted: true };
          }
          case 'delete_by_title': {
            const title = String(a.title ?? '');
            if (!title.trim()) throw new Error('title is required');
            return { deleted: await conversationService.deleteConversationByTitle(user.id, title) };
          }
          default:
            throw new Error('Unsupported conversation operation');
        }
      }
      case 'manage_oauth_authorization': {
        const { OAuthService } = await import('@/modules/oauth/oauth.service.js');
        const oauthService = container.resolve(OAuthService);
        const operation = String(a.operation ?? '');
        switch (operation) {
          case 'list':
            return oauthService.listUserAuthorizations(user.id);
          case 'update_scopes': {
            const clientId = String(a.clientId ?? '');
            const resource = String(a.resource ?? '');
            const scopes = Array.isArray(a.scopes) ? a.scopes.map(String) : [];
            if (!clientId) throw new Error('clientId is required');
            if (!resource) throw new Error('resource is required');
            if (scopes.length === 0) throw new Error('scopes are required');
            return oauthService.updateUserAuthorizationScopes(user, clientId, resource, scopes);
          }
          case 'revoke': {
            const clientId = String(a.clientId ?? '');
            const resource = String(a.resource ?? '');
            if (!clientId) throw new Error('clientId is required');
            if (!resource) throw new Error('resource is required');
            await oauthService.revokeUserAuthorization(user.id, clientId, resource);
            return { revoked: true };
          }
          default:
            throw new Error('Unsupported OAuth authorization operation');
        }
      }
      case 'manage_api_token': {
        const tokensService = container.resolve(TokensService);
        const operation = String(a.operation ?? '');
        switch (operation) {
          case 'list':
            return tokensService.listTokens(user.id);
          case 'create': {
            const input = CreateTokenSchema.parse({
              name: a.name,
              scopes: Array.isArray(a.scopes) ? canonicalizeScopes(a.scopes.map(String)) : a.scopes,
            });
            if (!isScopeSubset(input.scopes, user.scopes)) {
              throw new Error('Cannot create a token with scopes you do not possess');
            }
            return tokensService.createToken(user.id, input);
          }
          case 'update': {
            const tokenId = String(a.tokenId ?? '');
            if (!tokenId) throw new Error('tokenId is required');
            const input = UpdateTokenSchema.parse({
              name: a.name,
              scopes: Array.isArray(a.scopes) ? canonicalizeScopes(a.scopes.map(String)) : a.scopes,
            });
            if (input.scopes !== undefined && !isScopeSubset(input.scopes, user.scopes)) {
              throw new Error('Cannot update a token with scopes you do not possess');
            }
            await tokensService.updateToken(user.id, tokenId, input);
            return { success: true };
          }
          case 'revoke': {
            const tokenId = String(a.tokenId ?? '');
            if (!tokenId) throw new Error('tokenId is required');
            await tokensService.revokeToken(user.id, tokenId);
            return { success: true };
          }
          default:
            throw new Error('Unsupported API token operation');
        }
      }
      case 'get_license_status':
        return container.resolve(LicenseService).getStatus();
      case 'manage_license': {
        const service = container.resolve(LicenseService);
        switch (a.operation) {
          case 'activate':
            return service.activateKey(String(a.licenseKey ?? ''));
          case 'check':
            return service.checkNow();
          case 'clear':
            return service.clearKey();
          default:
            throw new Error('Unsupported license operation');
        }
      }
      case 'manage_housekeeping': {
        const service = container.resolve(HousekeepingService);
        switch (a.operation) {
          case 'get_config':
            return service.getConfig();
          case 'get_stats':
            return service.getStats();
          case 'get_history':
            return service.getRunHistory();
          case 'update_config': {
            this.ensureToolScope(user, 'housekeeping:configure');
            const config = isRecord(a.config) ? a.config : {};
            const updated = await service.updateConfig(config as Parameters<typeof service.updateConfig>[0]);
            if (typeof config.cronExpression === 'string') {
              container.resolve(SchedulerService).updateSchedule('housekeeping', config.cronExpression);
            }
            return updated;
          }
          case 'run':
            this.ensureToolScope(user, 'housekeeping:run');
            return service.runAll('manual', user.id);
          default:
            throw new Error('Unsupported housekeeping operation');
        }
      }
      case 'get_gateway_settings': {
        const authSettingsService = container.resolve(AuthSettingsService);
        const mcpSettingsService = container.resolve(McpSettingsService);
        const generalSettingsService = container.resolve(GeneralSettingsService);
        const networkSettingsService = container.resolve(NetworkSettingsService);
        const outboundWebhookPolicyService = container.resolve(OutboundWebhookPolicyService);
        const [settings, mcpSettings, generalSettings, networkSecurity, outboundWebhookPolicy, groups] =
          await Promise.all([
            authSettingsService.getConfig(),
            mcpSettingsService.getConfig(),
            generalSettingsService.getConfig(),
            networkSettingsService.getConfig(),
            outboundWebhookPolicyService.getConfig(),
            this.groupService.listGroups(),
          ]);
        const availableGroups = groups
          .filter((group) => isScopeSubset(getEffectiveGroupScopes(group), user.scopes))
          .map((group) => ({ id: group.id, name: group.name, isBuiltin: group.isBuiltin }));
        return {
          ...settings,
          mcpServerEnabled: mcpSettings.serverEnabled,
          mcpExtendedCompatibility: mcpSettings.extendedCompatibility,
          generalSettings,
          networkSecurity,
          outboundWebhookPolicy,
          availableGroups,
        };
      }
      case 'update_gateway_settings': {
        const input = UpdateAuthProvisioningSettingsSchema.parse(args);
        if (input.oidcDefaultGroupId) {
          const destGroup = await this.groupService.getGroup(input.oidcDefaultGroupId);
          if (!isScopeSubset(getEffectiveGroupScopes(destGroup), user.scopes)) {
            throw new Error('Cannot assign a group with permissions you do not possess');
          }
        }
        const authSettingsService = container.resolve(AuthSettingsService);
        const mcpSettingsService = container.resolve(McpSettingsService);
        const generalSettingsService = container.resolve(GeneralSettingsService);
        const networkSettingsService = container.resolve(NetworkSettingsService);
        const outboundWebhookPolicyService = container.resolve(OutboundWebhookPolicyService);
        const [settings, mcpSettings, generalSettings, networkSecurity, outboundWebhookPolicy] = await Promise.all([
          authSettingsService.updateConfig(input),
          mcpSettingsService.updateConfig({
            serverEnabled: input.mcpServerEnabled,
            extendedCompatibility: input.mcpExtendedCompatibility,
          }),
          input.generalSettings
            ? generalSettingsService.updateConfig(input.generalSettings)
            : generalSettingsService.getConfig(),
          input.networkSecurity
            ? networkSettingsService.updateConfig(input.networkSecurity)
            : networkSettingsService.getConfig(),
          input.outboundWebhookPolicy
            ? outboundWebhookPolicyService.updateConfig(input.outboundWebhookPolicy)
            : outboundWebhookPolicyService.getConfig(),
        ]);
        const groups = await this.groupService.listGroups();
        const availableGroups = groups
          .filter((group) => isScopeSubset(getEffectiveGroupScopes(group), user.scopes))
          .map((group) => ({ id: group.id, name: group.name, isBuiltin: group.isBuiltin }));
        return {
          ...settings,
          mcpServerEnabled: mcpSettings.serverEnabled,
          mcpExtendedCompatibility: mcpSettings.extendedCompatibility,
          generalSettings,
          networkSecurity,
          outboundWebhookPolicy,
          availableGroups,
        };
      }
      case 'manage_system_updates': {
        const operation = String(a.operation ?? '');
        const updateService = container.resolve(UpdateService);
        switch (operation) {
          case 'get_gateway_status':
            return updateService.getCachedStatus();
          case 'check_gateway':
            return updateService.checkForUpdates();
          case 'get_gateway_release_notes': {
            const version = String(a.version ?? '');
            if (!/^v?\d+\.\d+\.\d+$/.test(version)) throw new Error('version must be a semantic version');
            return { version, notes: await updateService.getReleaseNotes(version) };
          }
          case 'perform_gateway_update': {
            const version = String(a.version ?? '');
            if (!/^v?\d+\.\d+\.\d+$/.test(version)) throw new Error('version must be a semantic version');
            const status = await updateService.getCachedStatus();
            if (!status.updateAvailable) throw new Error('No gateway update is available');
            if (version !== status.latestVersion) throw new Error('Requested version does not match available update');
            const artifact = await updateService.prepareGatewayUpdate(version);
            const eventBus = container.resolve(EventBusService);
            eventBus.publish('system.update.changed', { updating: true, targetVersion: version });
            setTimeout(() => {
              updateService.performUpdate(version, artifact).catch((error) => {
                eventBus.publish('system.update.changed', { updating: false, targetVersion: version });
                logger.error('Gateway update failed from AI tool', {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                });
              });
            }, 500);
            return { status: 'updating', targetVersion: version };
          }
          case 'list_daemon_updates':
            return container.resolve(DaemonUpdateService).getCachedStatus();
          case 'check_daemon_updates':
            return container.resolve(DaemonUpdateService).checkForUpdates();
          case 'update_daemon': {
            const nodeId = String(a.nodeId ?? '');
            if (!nodeId) throw new Error('nodeId is required');
            const daemonUpdateService = container.resolve(DaemonUpdateService);
            const db = container.resolve<any>(TOKENS.DrizzleClient);
            const [node] = await db.select().from(nodesTable).where(eq(nodesTable.id, nodeId)).limit(1);
            if (!node) throw new Error('Node not found');

            const daemonType = node.type === 'databases' ? 'docker' : node.type;
            if (daemonType !== 'nginx' && daemonType !== 'docker' && daemonType !== 'monitoring') {
              throw new Error('This node does not run an updatable daemon');
            }
            const release = await daemonUpdateService.getLatestRelease(daemonType);
            if (!release) throw new Error('No release found for this daemon type');

            const arch = (((node.capabilities ?? {}) as Record<string, unknown>).architecture as string) ?? 'amd64';
            const artifact = await daemonUpdateService.prepareTrustedDaemonUpdate(
              daemonType,
              release.tagName,
              release.version,
              arch
            );
            await daemonUpdateService.markNodeUpdateInProgress(nodeId, release.version);
            try {
              const command = await container
                .resolve(NodeDispatchService)
                .sendUpdateDaemonCommand(
                  nodeId,
                  artifact.downloadUrl,
                  release.version,
                  artifact.checksum,
                  artifact.signedManifest
                );
              daemonUpdateService.trackNodeUpdateCompletion(nodeId, command.result);
              await command.accepted;
            } catch (error) {
              await daemonUpdateService.clearNodeUpdateInProgress(nodeId);
              throw error;
            }

            return { scheduled: true, targetVersion: release.version };
          }
          default:
            throw new Error('Unsupported system update operation');
        }
      }
      case 'get_audit_log':
        return this.auditService.getAuditLog({
          action: a.action,
          resourceType: a.resourceType,
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
        });
      case 'get_dashboard_stats': {
        const stats = await this.monitoringService.getDashboardStats(dashboardStatsOptionsForScopes(user.scopes));
        // Filter stats by user's read scopes — don't leak data they can't access
        const filtered: Record<string, unknown> = {};
        if (hasScopeBase(user.scopes, 'proxy:view')) filtered.proxyHosts = stats.proxyHosts;
        if (hasScopeBase(user.scopes, 'ssl:cert:view')) filtered.sslCertificates = stats.sslCertificates;
        if (hasScopeBase(user.scopes, 'pki:cert:view')) filtered.pkiCertificates = stats.pkiCertificates;
        if (hasScope(user.scopes, 'pki:ca:view:root') || hasScope(user.scopes, 'pki:ca:view:intermediate')) {
          filtered.cas = stats.cas;
        }
        if (hasScopeBase(user.scopes, 'nodes:details')) filtered.nodes = stats.nodes;
        if (Object.keys(filtered).length === 0) {
          return {
            message:
              'You do not have permission to view any dashboard statistics. Contact an administrator to get read access to resources.',
          };
        }
        return filtered;
      }

      case 'set_resource_pin':
        return {
          clientAction: {
            type: 'set_resource_pin',
            resourceType: a.resourceType,
            resourceId: a.resourceId,
            target: a.target,
            pinned: a.pinned,
            nodeId: a.nodeId,
            nodeSlug: a.nodeSlug,
            name: a.name,
            scopeResourceId: a.scopeResourceId,
          },
        };

      case 'open_node_enrollment':
        return {
          clientAction: {
            type: 'open_node_enrollment',
          },
        };

      case 'open_connector_setup':
        return {
          clientAction: {
            type: 'open_connector_setup',
            connector: a.connector,
            baseUrl: a.baseUrl,
            repositoryUrl: a.repositoryUrl,
            host: a.host,
          },
        };

      case 'manage_docker_container_config':
        return manageDockerContainerConfigTool({ dockerService: this.dockerService }, user, args);

      case 'manage_logging':
        return manageLoggingTool(user, args);
      case 'manage_status_page':
        return manageStatusPageTool(user, args);

      // ── Ask Question (handled client-side, backend just passes through) ──
      case 'ask_question':
        return { _askQuestion: true, question: a.question, options: a.options, allowFreeText: a.allowFreeText };

      case 'enter_plan_mode': {
        if (!runtimeContext.conversationId || !this.planService) throw new Error('Plan runtime is unavailable');
        return this.planService.enterPlan({
          userId: user.id,
          conversationId: runtimeContext.conversationId,
          title: a.title,
        });
      }
      case 'submit_plan': {
        if (!runtimeContext.conversationId || !this.planService) throw new Error('Plan runtime is unavailable');
        return this.planService.submitPlan(user.id, runtimeContext.conversationId, a as any);
      }
      case 'submit_plan_review': {
        if (!runtimeContext.conversationId || !this.planService) throw new Error('Plan runtime is unavailable');
        return this.planService.submitPlanReview({
          userId: user.id,
          conversationId: runtimeContext.conversationId,
          intentReview: a.intentReview,
          securityReview: a.securityReview,
        });
      }
      case 'start_plan_execution': {
        if (!runtimeContext.conversationId || !this.planService) throw new Error('Plan runtime is unavailable');
        return this.planService.startExecution(user.id, runtimeContext.conversationId);
      }
      case 'update_plan_step': {
        if (!runtimeContext.conversationId || !this.planService) throw new Error('Plan runtime is unavailable');
        return this.planService.updateStep({
          userId: user.id,
          conversationId: runtimeContext.conversationId,
          status: a.status,
          evidence: a.evidence,
          skipReason: a.skipReason,
        });
      }
      case 'pause_plan_execution': {
        if (!runtimeContext.conversationId || !this.planService) throw new Error('Plan runtime is unavailable');
        return this.planService.pause(user.id, runtimeContext.conversationId, a.reason, {
          requiresRevision: a.requiresRevision === true,
        });
      }
      case 'resume_plan_execution': {
        if (!runtimeContext.conversationId || !this.planService) throw new Error('Plan runtime is unavailable');
        return this.planService.resume(user.id, runtimeContext.conversationId);
      }
      case 'finalize_plan_execution': {
        if (!runtimeContext.conversationId || !this.planService) throw new Error('Plan runtime is unavailable');
        return this.planService.requestFinalVerification(user.id, runtimeContext.conversationId);
      }
      case 'submit_plan_verification': {
        if (!runtimeContext.conversationId || !this.planService) throw new Error('Plan runtime is unavailable');
        return this.planService.submitFinalVerification({
          userId: user.id,
          conversationId: runtimeContext.conversationId,
          verdict: a.verdict,
          summary: a.summary,
          findings: a.findings,
        });
      }

      // ── Documentation ──
      case 'internal_documentation':
        return getInternalDocumentation(a.topic, user.scopes);

      // ── Web Search ──
      case 'web_search':
        return executeWebSearch(this.settingsService, a.query, a.maxResults || 5);

      default:
        throw new Error(`Tool not implemented: ${toolName}`);
    }
  }

  async searchResources(
    user: User,
    args: Record<string, unknown>,
    runtimeContext: { pageContext?: PageContext; conversationId?: string } = {}
  ) {
    return findResource(
      {
        executeToolInternal: (executionUser, delegatedToolName, delegatedArgs) =>
          this.executeToolInternal(executionUser, delegatedToolName, delegatedArgs, runtimeContext),
        nodesService: this.nodesService,
        dockerService: this.dockerService,
        dockerSnapshotService: this.dockerSnapshotService,
      },
      user,
      args
    );
  }

  private async discoverTools(user: User, args: Record<string, unknown>, conversationId?: string) {
    const config = await this.settingsService.getConfig();
    const activePlan = conversationId ? await this.planService?.getActivePlanSnapshot(user.id, conversationId) : null;
    const callableNames = new Set(
      getOpenAITools(config.disabledTools, user.scopes, config.webSearchEnabled, {
        sandboxEnabled: config.sandboxEnabled,
        planningMode:
          activePlan?.status === 'drafting' ||
          activePlan?.status === 'validating' ||
          activePlan?.status === 'verifying',
      })
        .filter((tool) => isToolNameAllowedForPlanState(tool.function.name, activePlan?.status ?? null))
        .map((tool) => tool.function.name)
    );
    const requestedCategories = [
      ...(Array.isArray(args.categories)
        ? args.categories.filter((category): category is string => typeof category === 'string')
        : []),
      ...(stringArg(args.category) ? [stringArg(args.category)!] : []),
    ];
    const normalizedRequestedCategories = [
      ...new Set(requestedCategories.map((category) => category.trim()).filter(Boolean)),
    ];
    if (normalizedRequestedCategories.length > 3) {
      throw new AppError(400, 'AI_TOOL_DISCOVERY_TOO_BROAD', 'Activate at most three tool categories at a time');
    }
    const query = stringArg(args.query)?.toLowerCase();
    const includeTools = boolArg(args.includeTools);

    const callableTools = AI_TOOLS.filter((tool) => callableNames.has(tool.name) && !isBaseAIToolName(tool.name));
    const categoryMap = new Map<string, { toolCount: number; destructiveCount: number }>();

    for (const tool of callableTools) {
      const current = categoryMap.get(tool.category) ?? { toolCount: 0, destructiveCount: 0 };
      current.toolCount += 1;
      if (tool.destructive) current.destructiveCount += 1;
      categoryMap.set(tool.category, current);
    }

    const categories = [...categoryMap.entries()]
      .map(([name, summary]) => ({ name, ...summary }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const categoryNames = new Map(categories.map((category) => [category.name.toLowerCase(), category.name]));
    const explicitCategories = normalizedRequestedCategories.map((category) => {
      const matched = categoryNames.get(category.toLowerCase());
      if (!matched)
        throw new AppError(400, 'AI_TOOL_CATEGORY_UNKNOWN', `Unknown or unavailable tool category: ${category}`);
      return matched;
    });
    if (includeTools && explicitCategories.length === 0) {
      return {
        categories,
        recommendedToolsets: rankToolCategories(callableTools, query).slice(0, 3),
        totalCallableTools: callableTools.length,
        nextStep:
          'Choose one to three recommended category names, then call discover_tools with categories and includeTools:true.',
      };
    }

    const recommendedToolsets = query ? rankToolCategories(callableTools, query).slice(0, 3) : [];

    const tools = includeTools
      ? callableTools
          .filter((tool) => explicitCategories.includes(tool.category))
          .map((tool) => ({
            name: tool.name,
            category: tool.category,
            description: tool.description,
            destructive: tool.destructive,
            requiredScope: tool.requiredScope,
            invalidateStores: tool.invalidateStores,
          }))
      : undefined;

    return {
      categories:
        explicitCategories.length > 0
          ? categories.filter((category) => explicitCategories.includes(category.name))
          : categories,
      tools,
      recommendedToolsets,
      ...(includeTools ? { discoveredToolsets: explicitCategories } : {}),
      totalCallableTools: callableTools.length,
      nextStep: includeTools
        ? 'Use a visible tool for the current step. When the task moves to another step, call discover_tools again to replace this working set.'
        : query
          ? 'Choose one to three recommended category names, then call discover_tools with categories and includeTools:true.'
          : 'Use a visible base tool directly. If the category is unclear, call discover_tools with a targeted query.',
    };
  }

  private async getConversationDiscoveredToolsets(user: User, conversationId?: string): Promise<string[]> {
    if (!conversationId) return [];
    try {
      const conversation = await container.resolve(AIConversationService).getConversation(user.id, conversationId);
      return conversation?.discoveredToolsets ?? [];
    } catch (error) {
      logger.warn('Failed to load AI conversation discovered toolsets', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async buildModelTools(
    config: { disabledTools: string[]; webSearchEnabled: boolean; sandboxEnabled: boolean },
    user: User,
    discoveredToolsets: string[],
    conversationId?: string
  ) {
    const activePlan = conversationId ? await this.planService?.getActivePlanSnapshot(user.id, conversationId) : null;
    return getOpenAITools(config.disabledTools, user.scopes, config.webSearchEnabled, {
      discoveredToolsets,
      sandboxEnabled: config.sandboxEnabled,
      planningMode:
        activePlan?.status === 'drafting' || activePlan?.status === 'validating' || activePlan?.status === 'verifying',
    }).filter((tool) => isToolNameAllowedForPlanState(tool.function.name, activePlan?.status ?? null));
  }

  private processCommentToolCalls(input: {
    parsedToolCalls: PendingToolCall[];
    messages: Record<string, unknown>[];
    runtimeMessages: ChatMessage[];
    requestId: string;
  }): { accepted: boolean; events: WSServerMessage[] } {
    let acceptedComment = '';
    const events: WSServerMessage[] = [];

    for (const tc of input.parsedToolCalls) {
      let content: string;
      if (tc.name === SEND_COMMENT_TOOL_NAME) {
        const comment = commentMessageFromArgs(tc.parsedArgs);
        if (comment && !acceptedComment) {
          acceptedComment = comment;
          content = JSON.stringify({ ok: true, delivered: true });
        } else {
          content = JSON.stringify(
            comment ? 'Only one send_comment call is allowed at a time.' : SEND_COMMENT_EMPTY_ERROR
          );
        }
      } else {
        content = JSON.stringify(SEND_COMMENT_MIXED_ERROR);
      }

      input.messages.push({ role: 'tool', tool_call_id: tc.id, content });
      input.runtimeMessages.push({ role: 'tool', tool_call_id: tc.id, content });
    }

    if (acceptedComment) {
      input.runtimeMessages.push({ role: 'assistant', content: acceptedComment });
      input.messages = ensureProviderLanguageLock(input.messages);
      ensureRuntimeLanguageLock(input.runtimeMessages);
      events.push({ type: 'assistant_comment', requestId: input.requestId, content: acceptedComment });
    }

    return { accepted: !!acceptedComment, events };
  }

  private async persistToolRuntimeState(
    user: User,
    options: ToolExecutionOptions,
    toolName: string,
    result: unknown
  ): Promise<void> {
    if (!options.conversationId) return;
    const discoveredToolsets = toolName === 'discover_tools' ? discoveredToolsetsFromResult(result) : undefined;

    if (!options.pageContext && discoveredToolsets === undefined) return;

    try {
      await container.resolve(AIConversationService).updateRuntimeState(user.id, options.conversationId, {
        lastContext: options.pageContext,
        discoveredToolsets,
      });
    } catch (error) {
      logger.warn('Failed to persist AI conversation runtime state', {
        conversationId: options.conversationId,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async persistInferredToolsets(
    user: User,
    conversationId: string | undefined,
    discoveredToolsets: string[]
  ): Promise<void> {
    if (!conversationId) return;
    try {
      await container.resolve(AIConversationService).updateRuntimeState(user.id, conversationId, {
        discoveredToolsets,
      });
    } catch (error) {
      logger.warn('Failed to persist inferred AI conversation toolsets', {
        conversationId,
        discoveredToolsets,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private ensureToolScope(user: User, scope: string) {
    if (!hasScope(user.scopes, scope)) {
      throw new Error(`PERMISSION_DENIED: Missing required scope ${scope}`);
    }
  }

  private ensureToolScopeForResource(user: User, baseScope: string, resourceId: string) {
    if (!hasScopeForResource(user.scopes, baseScope, resourceId)) {
      throw new Error(`PERMISSION_DENIED: Missing required scope ${baseScope}:${resourceId}`);
    }
  }

  private async toProviderMessage(user: User, message: ChatMessage, config: { supportsImages: boolean }) {
    const steerPrefix = message.steer
      ? 'User clarification received while you were working. Apply it to the remaining work without stopping unless explicitly requested:\n\n'
      : '';
    const msg: Record<string, unknown> = {
      role: message.role,
      content: message.steer ? `${steerPrefix}${message.content ?? ''}` : message.content,
    };
    if (message.role === 'user' && config.supportsImages && message.attachments?.length && this.artifactService) {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content || message.steer) {
        parts.push({ type: 'text', text: `${steerPrefix}${message.content ?? ''}` });
      }
      const imageParts: Array<Record<string, unknown> | null> = await Promise.all(
        message.attachments
          .filter((attachment) => attachment.kind === 'image')
          .map((attachment) => this.attachmentToImagePart(user.id, attachment))
      );
      parts.push(...imageParts.filter((part): part is Record<string, unknown> => part !== null));
      if (parts.length > 0) msg.content = parts;
    }
    if (message.tool_calls) msg.tool_calls = message.tool_calls;
    if (message.tool_call_id) msg.tool_call_id = message.tool_call_id;
    if (message.name) msg.name = message.name;
    return msg;
  }

  private async attachmentToImagePart(
    userId: string,
    attachment: AIMessageAttachment
  ): Promise<Record<string, unknown> | null> {
    if (!attachment.mediaType.startsWith('image/')) return null;
    try {
      const artifact = await this.artifactService?.getDownload(userId, attachment.artifactId);
      if (!artifact) return null;
      const buffer = await fs.readFile(artifact.filePath);
      const dataUrl = `data:${artifact.metadata.mediaType};base64,${buffer.toString('base64')}`;
      return { type: 'image_url', image_url: { url: dataUrl } };
    } catch (error) {
      logger.warn('Failed to attach AI message image artifact', {
        artifactId: attachment.artifactId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async shouldAutoCompactContext(
    user: User,
    clientMessages: ChatMessage[],
    pageContext: PageContext | undefined,
    conversationId?: string,
    selectedModel?: string,
    selectedReasoningEffort?: string
  ): Promise<boolean> {
    const provider = await this.resolveProviderSession(user, {
      requestId: `context-estimate:${conversationId ?? 'new'}`,
      conversationId,
      requestedModel: selectedModel,
      requestedReasoningEffort: selectedReasoningEffort,
      signal: new AbortController().signal,
    });
    const { config } = provider;
    const systemPrompt = await this.buildSystemPrompt(user, pageContext, conversationId);
    const discoveredToolsets = mergeToolsets(
      (await this.getConversationDiscoveredToolsets(user, conversationId)) ?? [],
      inferDiscoveredToolsetsFromMessages(clientMessages)
    );
    const tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
    const providerMessages = [
      { role: 'system', content: systemPrompt },
      ...(await Promise.all(clientMessages.map((message) => this.toProviderMessage(user, message, config)))),
    ];
    const toolsTokens = estimateToolSchemaTokens(tools);
    const totalTokens = estimateProviderMessagesTokens(providerMessages) + toolsTokens;
    return totalTokens >= provider.contextLimits.autoCompactTokenLimit;
  }

  async compactConversationContext(
    user: User,
    clientMessages: ChatMessage[],
    pageContext: PageContext | undefined,
    signal: AbortSignal,
    trigger: AIContextCompactionTrigger,
    selectedModel?: string,
    conversationId?: string,
    selectedReasoningEffort?: string
  ): Promise<AIContextCompactionResult> {
    const provider = await this.resolveProviderSession(user, {
      requestId: `compact:${conversationId ?? 'new'}`,
      conversationId,
      requestedModel: selectedModel,
      requestedReasoningEffort: selectedReasoningEffort,
      signal,
      isCompaction: true,
    });
    const { config } = provider;
    const providerConversationMessages = await Promise.all(
      clientMessages.map((message) => this.toProviderMessage(user, message, config))
    );
    const systemPrompt = await this.buildSystemPrompt(user, pageContext, conversationId);
    const discoveredToolsets = mergeToolsets(
      (await this.getConversationDiscoveredToolsets(user, conversationId)) ?? [],
      inferDiscoveredToolsetsFromMessages(clientMessages)
    );
    const tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
    const systemTokens = estimateProviderMessagesTokens([{ role: 'system', content: systemPrompt }]);
    const toolsTokens = estimateToolSchemaTokens(tools);
    const fixedOverheadTokens = systemTokens + toolsTokens;
    const targetTokens = Math.max(1, Math.floor(provider.contextLimits.maxInputTokens * 0.4));
    const desiredSummaryBudget = clampIntegerValue(Math.floor(targetTokens * 0.05), 512, 12_000);
    const recentBudget = Math.max(0, targetTokens - fixedOverheadTokens - desiredSummaryBudget);
    const selection = selectCompactionBoundary(clientMessages, providerConversationMessages, recentBudget);
    const preCompactionTokens = fixedOverheadTokens + estimateProviderMessagesTokens(providerConversationMessages);
    if (selection.source.length === 0) {
      if (trigger === 'auto' && preCompactionTokens > provider.contextLimits.maxInputTokens) {
        throw new AppError(
          409,
          'AI_CONTEXT_TOO_LARGE',
          'The active context exceeds the model input limit, but its minimal atomic turn cannot be compacted safely'
        );
      }
      return {
        compacted: false,
        summary: 'There is not enough older context to compact yet.',
        compactedMessageCount: 0,
        compactVersion: 2,
        compactEpoch: Math.max(0, ...clientMessages.map((message) => message.compactEpoch ?? 0)),
        compactBoundaryMessageId: null,
        sourceTokenEstimate: 0,
        resultTokenEstimate: 0,
        trigger,
        preCompactionTokens,
        reconstructedTokens: preCompactionTokens,
        targetTokens,
        targetAchieved: preCompactionTokens <= targetTokens,
      };
    }
    const compactBoundaryMessageId = selection.source.at(-1)?.id;
    if (!compactBoundaryMessageId) {
      throw new AppError(
        409,
        'AI_COMPACTION_BOUNDARY_UNKNOWN',
        'The durable compaction boundary could not be identified; reload the conversation and retry'
      );
    }

    const sourceText = serializeMessagesForCompaction(selection.source);
    const messages = [
      { role: 'system', content: buildCompactionSystemPrompt(trigger) },
      {
        role: 'user',
        content: buildCompactionUserPrompt({
          sourceText,
          sourceMessageCount: selection.source.length,
        }),
      },
    ];
    assertProviderInputWithinLimits(messages, [], provider.contextLimits);
    const targetSummaryCapacity = targetTokens - fixedOverheadTokens - selection.recentTokens;
    const softSummaryCapacity =
      provider.contextLimits.autoCompactTokenLimit - fixedOverheadTokens - selection.recentTokens;
    const summaryOutputBudget = Math.max(
      256,
      Math.min(
        desiredSummaryBudget,
        Math.max(256, targetSummaryCapacity >= 256 ? targetSummaryCapacity : softSummaryCapacity)
      )
    );

    let summary = '';
    for await (const event of provider.stream(messages, [], { maxOutputTokens: summaryOutputBudget })) {
      if (event.type === 'text_delta') {
        summary += event.content;
      } else {
        summary = event.response.content;
      }
    }

    const cleanedSummary =
      summary.trim() || 'Older context was compacted, but the compaction model returned an empty summary.';
    const resultTokenEstimate = estimateTextTokens(cleanedSummary);
    if (resultTokenEstimate > summaryOutputBudget) {
      throw new AppError(
        409,
        'AI_COMPACTION_SUMMARY_TOO_LARGE',
        `Compaction returned ${resultTokenEstimate} estimated tokens, above its ${summaryOutputBudget} token output budget`
      );
    }

    const reconstructedMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'assistant', content: cleanedSummary },
      ...providerConversationMessages.slice(selection.source.length),
    ];
    const reconstructedTokens = estimateProviderMessagesTokens(reconstructedMessages) + estimateToolSchemaTokens(tools);
    assertProviderInputWithinLimits(reconstructedMessages, tools, provider.contextLimits);
    if (reconstructedTokens > provider.contextLimits.autoCompactTokenLimit) {
      throw new AppError(
        409,
        'AI_CONTEXT_TOO_LARGE',
        `Compacted context still requires ${reconstructedTokens} estimated tokens, above the ${provider.contextLimits.autoCompactTokenLimit} token soft limit`
      );
    }

    return {
      compacted: true,
      summary: cleanedSummary,
      compactedMessageCount: selection.source.length,
      compactVersion: 2,
      compactEpoch: Math.max(0, ...clientMessages.map((message) => message.compactEpoch ?? 0)) + 1,
      compactBoundaryMessageId,
      sourceTokenEstimate: selection.sourceTokens,
      resultTokenEstimate,
      trigger,
      preCompactionTokens,
      reconstructedTokens,
      targetTokens,
      targetAchieved: reconstructedTokens <= targetTokens,
    };
  }

  /**
   * Stream a chat completion with tool calling.
   * Yields WSServerMessage events for the WebSocket handler to forward.
   */
  async *streamChat(
    user: User,
    clientMessages: ChatMessage[],
    pageContext: PageContext | undefined,
    signal: AbortSignal,
    requestId: string,
    conversationId?: string,
    autoCompactContext?: AutoCompactContextHook,
    selectedModel?: string,
    selectedReasoningEffort?: string,
    receivePendingSteers?: ReceivePendingSteersHook
  ): AsyncGenerator<WSServerMessage> {
    let provider: AIProviderSession;
    try {
      provider = await this.resolveProviderSession(user, {
        requestId,
        conversationId,
        requestedModel: selectedModel,
        requestedReasoningEffort: selectedReasoningEffort,
        signal,
      });
    } catch (error) {
      yield {
        type: 'error',
        requestId,
        message: error instanceof Error ? error.message : 'AI provider is unavailable',
      };
      yield { type: 'done', requestId };
      return;
    }
    const { config } = provider;

    const systemPrompt = await this.buildSystemPrompt(user, pageContext, conversationId);
    const inferredToolsets = inferDiscoveredToolsetsFromMessages(clientMessages);
    let discoveredToolsets = mergeToolsets([], inferredToolsets);
    await this.persistInferredToolsets(user, conversationId, discoveredToolsets);
    let tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);

    let runtimeMessages = clientMessages.filter(
      (message) => message.role !== 'system' || message.hiddenSystemEvent === true
    );
    const buildProviderMessages = async () => [
      { role: 'system', content: systemPrompt },
      ...(await Promise.all(runtimeMessages.map((message) => this.toProviderMessage(user, message, config)))),
    ];
    let messages: Record<string, unknown>[] = [];

    const maxRounds = config.maxToolRounds;
    let roundsSinceComment = 0;
    let commentRepairAttempts = 0;
    let runLanguageLocked = hasRunLanguageLock(runtimeMessages);

    while (true) {
      if (signal.aborted) return;

      if (receivePendingSteers) runtimeMessages = await receivePendingSteers(runtimeMessages);

      if (autoCompactContext) {
        try {
          const previousCompactEpoch = latestCompactEpoch(runtimeMessages);
          runtimeMessages = await autoCompactContext(runtimeMessages);
          if (latestCompactEpoch(runtimeMessages) > previousCompactEpoch) {
            discoveredToolsets = [];
            tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
          }
        } catch (error) {
          if (error instanceof AppError && error.code === 'AI_CONTEXT_TOO_LARGE') {
            yield { type: 'context_blocked', requestId, reason: error.message };
            yield { type: 'done', requestId };
            return;
          }
          throw error;
        }
      }
      if (runLanguageLocked) ensureRuntimeLanguageLock(runtimeMessages);
      const commentRequired = roundsSinceComment >= maxRounds;
      const activeTools = commentRequired ? commentToolFrom(tools) : tools;
      if (commentRequired && activeTools.length === 0) {
        messages = await buildProviderMessages();
        messages = [...messages, { role: 'system', content: TOOL_COMMENT_REQUIRED_MESSAGE }];
        assertProviderInputWithinLimits(messages, [], provider.contextLimits);
        yield* this.streamFinalTextResponse({ provider, messages, requestId, signal });
        return;
      }
      messages = await buildProviderMessages();
      messages = commentRequired ? [...messages, { role: 'system', content: TOOL_COMMENT_REQUIRED_MESSAGE }] : messages;
      assertProviderInputWithinLimits(messages, activeTools, provider.contextLimits);

      let contentBuffer = '';
      let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

      try {
        for await (const event of provider.stream(messages, activeTools)) {
          if (event.type === 'text_delta') {
            contentBuffer += event.content;
            yield {
              type: commentRequired ? 'assistant_comment_delta' : 'text_delta',
              requestId,
              content: event.content,
            };
          } else {
            contentBuffer = event.response.content;
            toolCalls = event.response.toolCalls;
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : 'Stream error';
        logger.error('AI provider error', { error: err });
        if (isContextWindowError(err)) {
          yield {
            type: 'context_blocked',
            requestId,
            reason:
              'This chat has run out of usable context and could not be compacted automatically. Clear part of the oldest context or start a new chat.',
          };
          yield { type: 'done', requestId };
          return;
        }
        yield { type: 'error', requestId, message };
        yield { type: 'done', requestId };
        return;
      }

      // If no tool calls, we're done
      toolCalls = toolCalls.filter((tc) => tc.id && tc.name);
      if (toolCalls.length === 0) {
        if (commentRequired) {
          const comment = contentBuffer.trim();
          if (comment) {
            runtimeMessages.push({ role: 'assistant', content: comment });
            ensureRuntimeLanguageLock(runtimeMessages);
            runLanguageLocked = true;
            yield { type: 'assistant_comment', requestId, content: comment };
            roundsSinceComment = 0;
            commentRepairAttempts = 0;
            continue;
          }
          yield { type: 'error', requestId, message: SEND_COMMENT_EMPTY_ERROR };
          yield { type: 'done', requestId };
          return;
        }
        runtimeMessages.push({ role: 'assistant', content: contentBuffer });
        this.roundInlineTokens.delete(requestId);
        yield { type: 'done', requestId };
        return;
      }

      // Process tool calls
      const rawToolCalls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));

      messages.push({
        role: 'assistant',
        content: contentBuffer || null,
        tool_calls: rawToolCalls,
      });
      runtimeMessages.push({
        role: 'assistant',
        content: contentBuffer || null,
        tool_calls: rawToolCalls,
      });

      // Parse all tool args first
      let parsedToolCalls: PendingToolCall[] = toolCalls.map((tc) => {
        const validation = parseAndValidateAIToolArguments(tc.name, tc.arguments);
        return validation.ok
          ? { ...tc, parsedArgs: validation.arguments }
          : { ...tc, parsedArgs: {}, validationError: validation.error };
      });
      if (parsedToolCalls.some((tc) => tc.name === SEND_COMMENT_TOOL_NAME)) {
        const result = this.processCommentToolCalls({ parsedToolCalls, messages, runtimeMessages, requestId });
        for (const event of result.events) yield event;
        if (result.accepted) {
          runLanguageLocked = true;
          roundsSinceComment = 0;
          commentRepairAttempts = 0;
        } else {
          commentRepairAttempts += 1;
          if (commentRepairAttempts >= SEND_COMMENT_REPAIR_LIMIT) {
            yield { type: 'error', requestId, message: SEND_COMMENT_EMPTY_ERROR };
            yield { type: 'done', requestId };
            return;
          }
        }
        continue;
      }
      this.roundInlineTokens.set(requestId, 0);
      const approvalMode = await this.resolveCurrentApprovalMode(user);
      const toolRound = createToolRoundStartEvent(requestId, parsedToolCalls, approvalMode, messages);
      yield toolRound;

      for (const tc of parsedToolCalls.filter((call) => call.validationError)) {
        const error = tc.validationError!;
        yield { type: 'tool_call_start', requestId, id: tc.id, name: tc.name, arguments: {} };
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error }) });
        runtimeMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error }) });
        yield { type: 'tool_result', requestId, id: tc.id, name: tc.name, result: undefined, error };
      }
      parsedToolCalls = parsedToolCalls.filter((call) => !call.validationError);
      if (parsedToolCalls.length === 0) continue;

      roundsSinceComment += 1;

      // Separate questions, tools that require approval, and immediate tools.
      const questionTools: typeof parsedToolCalls = [];
      const approvalTools: typeof parsedToolCalls = [];
      const immediateTools: typeof parsedToolCalls = [];

      for (const tc of parsedToolCalls) {
        if (tc.name === 'ask_question') {
          questionTools.push(tc);
          continue;
        }
        if (getAIToolApprovalDecision(tc.name, approvalMode, tc.parsedArgs).requiresApproval) {
          approvalTools.push(tc);
          continue;
        }
        immediateTools.push(tc);
      }

      for (const tc of immediateTools) {
        yield { type: 'tool_call_start', requestId, id: tc.id, name: tc.name, arguments: tc.parsedArgs };

        const result = await this.executeTool(user, tc.name, tc.parsedArgs, { pageContext, conversationId });
        if (result.credentialChallenge) {
          yield {
            type: 'credential_authorization_required',
            requestId,
            id: tc.id,
            name: tc.name,
            provider: result.credentialChallenge.provider,
            connectorId: result.credentialChallenge.connectorId,
            arguments: tc.parsedArgs,
            roundId: toolRound.roundId,
            _rawArguments: tc.parsedArgs,
            _pendingMessages: messages,
            _queuedApprovals: approvalTools.map((approval) => ({
              id: approval.id,
              name: approval.name,
              arguments: approvalDisplayArgs(approval.name, approval.parsedArgs),
              rawArguments: approval.parsedArgs,
            })),
          } as any;
          return;
        }
        if (tc.name === 'discover_tools') {
          const activatedToolsets = discoveredToolsetsFromResult(result.result);
          if (activatedToolsets) {
            discoveredToolsets = mergeToolsets([], activatedToolsets);
            tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
          }
        }
        const resourceReferences = await this.toolResourceReferences(
          tc.name,
          tc.parsedArgs,
          result.result,
          result.error
        );
        const prepared = await this.prepareToolOutput({
          userId: user.id,
          conversationId,
          sourceRunId: requestId,
          sourceToolCallId: tc.id,
          toolName: tc.name,
          result: result.result,
          error: result.error,
          contextLimits: provider.contextLimits,
          systemPrompt,
          tools,
          resourceReferences,
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: safeStringify(prepared.modelResult),
        });
        runtimeMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: safeStringify(prepared.modelResult),
        });
        yield {
          type: 'tool_result',
          requestId,
          id: tc.id,
          name: tc.name,
          result: prepared.eventResult,
          error: prepared.error,
          clientAction: prepared.clientAction,
          resourceReferences: prepared.resourceReferences,
        };
        if (result.invalidateStores.length > 0) {
          yield { type: 'invalidate_stores', requestId, stores: result.invalidateStores };
        }
        if (shouldEndRunAfterPlanTool(tc.name, result.result, result.error)) {
          yield { type: 'done', requestId };
          return;
        }
        if (tc.name === 'end_conversation' && !result.error) {
          yield {
            type: 'conversation_ended',
            requestId,
            reason: conversationEndReason(result.result, 'This conversation has been ended.'),
          };
          yield { type: 'done', requestId };
          return;
        }
      }

      // Questions take priority over destructive tools — show all questions first
      if (questionTools.length > 0) {
        for (const tc of questionTools) {
          yield { type: 'tool_call_start', requestId, id: tc.id, name: tc.name, arguments: tc.parsedArgs };
        }
        // Pause with the first question; frontend will collect all answers
        const first = questionTools[0];
        yield {
          type: 'tool_approval_required',
          requestId,
          id: first.id,
          name: 'ask_question',
          arguments: first.parsedArgs,
          roundId: toolRound.roundId,
          _pendingMessages: messages,
          _allQuestions: questionTools.map((q) => ({ id: q.id, args: q.parsedArgs })),
          _queuedApprovals: approvalTools.map((approval) => ({
            id: approval.id,
            name: approval.name,
            arguments: approvalDisplayArgs(approval.name, approval.parsedArgs),
            rawArguments: approval.parsedArgs,
          })),
        } as any;
        return;
      }

      // Approval pause. Queue later approval-gated calls instead of returning fake "skipped" tool results.
      if (approvalTools.length > 0) {
        const [approvalTool, ...queued] = approvalTools;
        yield {
          type: 'tool_call_start',
          requestId,
          id: approvalTool.id,
          name: approvalTool.name,
          arguments: approvalDisplayArgs(approvalTool.name, approvalTool.parsedArgs),
        };
        yield {
          type: 'tool_approval_required',
          requestId,
          id: approvalTool.id,
          name: approvalTool.name,
          arguments: approvalDisplayArgs(approvalTool.name, approvalTool.parsedArgs),
          roundId: toolRound.roundId,
          _rawArguments: approvalTool.parsedArgs,
          _pendingMessages: messages,
          _queuedApprovals: queued.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: approvalDisplayArgs(tc.name, tc.parsedArgs),
            rawArguments: tc.parsedArgs,
          })),
        } as any;
        return;
      }

      // Continue to next round (LLM will see tool results)
      if (contentBuffer.trim()) {
        ensureRuntimeLanguageLock(runtimeMessages);
        runLanguageLocked = true;
      }
    }
  }

  /**
   * Resume streaming after a destructive tool approval/rejection.
   */
  async *resumeAfterApproval(
    user: User,
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    approved: boolean,
    pendingMessages: Record<string, unknown>[],
    pageContext: PageContext | undefined,
    signal: AbortSignal,
    requestId: string,
    answer?: string,
    answers?: Record<string, string>,
    queuedApprovals: QueuedApproval[] = [],
    conversationId?: string,
    autoCompactContext?: AutoCompactContextHook,
    rejectionError?: string,
    selectedModel?: string,
    selectedReasoningEffort?: string,
    approvalDecisions: Record<string, boolean> = {},
    receivePendingSteers?: ReceivePendingSteersHook,
    precomputedResult?: {
      result: Record<string, unknown>;
      error?: string;
      rejected?: boolean;
    }
  ): AsyncGenerator<WSServerMessage> {
    let continuationProvider: AIProviderSession | undefined;
    if (precomputedResult) {
      pendingMessages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: safeStringify(precomputedResult.result),
      });
      yield {
        type: 'tool_result',
        requestId,
        id: toolCallId,
        name: toolName,
        result: precomputedResult.result,
        ...(precomputedResult.error ? { error: precomputedResult.error } : {}),
        ...(precomputedResult.rejected ? { rejected: true } : {}),
      };
    } else if (toolName === 'ask_question') {
      // Batch answers: { toolCallId: answer, ... }
      const allAnswers: Record<string, string> = { ...answers };
      if (answer) allAnswers[toolCallId] = answer;
      // Only inject answers for tool calls that don't already have a response in pendingMessages
      const existingToolResultIds = new Set(
        pendingMessages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id as string)
      );
      for (const [tcId, ans] of Object.entries(allAnswers)) {
        if (existingToolResultIds.has(tcId)) continue; // Already responded in a previous round
        const answerText = ans || 'No answer provided';
        pendingMessages.push({ role: 'tool', tool_call_id: tcId, content: JSON.stringify({ answer: answerText }) });
        yield { type: 'tool_result', requestId, id: tcId, name: 'ask_question', result: { answer: answerText } };
      }
    } else if (!approved) {
      const rejectedMessage = rejectionError ?? 'User rejected this action.';
      pendingMessages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: JSON.stringify({ error: rejectedMessage }),
      });
      yield {
        type: 'tool_result',
        requestId,
        id: toolCallId,
        name: toolName,
        result: undefined,
        error: rejectedMessage,
        rejected: true,
      };
    } else {
      const validation = validateAIToolArguments(toolName, toolArgs);
      if (!validation.ok) {
        pendingMessages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify({ error: validation.error }),
        });
        yield {
          type: 'tool_result',
          requestId,
          id: toolCallId,
          name: toolName,
          result: undefined,
          error: validation.error,
        };
      } else {
        const result = await this.executeTool(user, toolName, validation.arguments, { pageContext, conversationId });
        if (result.credentialChallenge) {
          yield {
            type: 'credential_authorization_required',
            requestId,
            id: toolCallId,
            name: toolName,
            provider: result.credentialChallenge.provider,
            connectorId: result.credentialChallenge.connectorId,
            arguments: approvalDisplayArgs(toolName, validation.arguments),
            _rawArguments: validation.arguments,
            _pendingMessages: pendingMessages,
            _queuedApprovals: queuedApprovalDisplayArgs(queuedApprovals),
          } as any;
          return;
        }
        continuationProvider = await this.resolveProviderSession(user, {
          requestId,
          conversationId,
          requestedModel: selectedModel,
          requestedReasoningEffort: selectedReasoningEffort,
          signal,
        });
        const continuationSystemPrompt = await this.buildSystemPrompt(user, pageContext, conversationId);
        const continuationTools = await this.buildModelTools(
          continuationProvider.config,
          user,
          await this.getConversationDiscoveredToolsets(user, conversationId),
          conversationId
        );
        const resourceReferences = await this.toolResourceReferences(
          toolName,
          validation.arguments,
          result.result,
          result.error
        );
        const prepared = await this.prepareToolOutput({
          userId: user.id,
          conversationId,
          sourceRunId: requestId,
          sourceToolCallId: toolCallId,
          toolName,
          result: result.result,
          error: result.error,
          contextLimits: continuationProvider.contextLimits,
          systemPrompt: continuationSystemPrompt,
          tools: continuationTools,
          resourceReferences,
        });
        pendingMessages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: safeStringify(prepared.modelResult),
        });
        yield {
          type: 'tool_result',
          requestId,
          id: toolCallId,
          name: toolName,
          result: prepared.eventResult,
          error: prepared.error,
          clientAction: prepared.clientAction,
          resourceReferences: prepared.resourceReferences,
        };
        if (result.invalidateStores.length > 0) {
          yield { type: 'invalidate_stores', requestId, stores: result.invalidateStores };
        }
        if (toolName === 'end_conversation' && !result.error) {
          yield {
            type: 'conversation_ended',
            requestId,
            reason: conversationEndReason(result.result, 'This conversation has been ended.'),
          };
          yield { type: 'done', requestId };
          return;
        }
      }
    }

    if (queuedApprovals.length > 0) {
      const [nextApproval, ...remainingApprovals] = queuedApprovals;
      if (Object.hasOwn(approvalDecisions, nextApproval.id)) {
        yield* this.resumeAfterApproval(
          user,
          nextApproval.id,
          nextApproval.name,
          nextApproval.arguments,
          approvalDecisions[nextApproval.id],
          pendingMessages,
          pageContext,
          signal,
          requestId,
          undefined,
          undefined,
          remainingApprovals,
          conversationId,
          autoCompactContext,
          undefined,
          selectedModel,
          selectedReasoningEffort,
          approvalDecisions,
          receivePendingSteers
        );
        return;
      }
      yield {
        type: 'tool_call_start',
        requestId,
        id: nextApproval.id,
        name: nextApproval.name,
        arguments: approvalDisplayArgs(nextApproval.name, nextApproval.arguments),
      };
      yield {
        type: 'tool_approval_required',
        requestId,
        id: nextApproval.id,
        name: nextApproval.name,
        arguments: approvalDisplayArgs(nextApproval.name, nextApproval.arguments),
        _rawArguments: nextApproval.arguments,
        _pendingMessages: pendingMessages,
        _queuedApprovals: queuedApprovalDisplayArgs(remainingApprovals),
      } as any;
      return;
    }

    // Continue streaming with the updated messages
    let provider: AIProviderSession;
    try {
      provider =
        continuationProvider ??
        (await this.resolveProviderSession(user, {
          requestId,
          conversationId,
          requestedModel: selectedModel,
          requestedReasoningEffort: selectedReasoningEffort,
          signal,
        }));
    } catch (error) {
      yield {
        type: 'error',
        requestId,
        message: error instanceof Error ? error.message : 'AI provider is unavailable',
      };
      yield { type: 'done', requestId };
      return;
    }
    const { config } = provider;

    pendingMessages = orderLatestToolRoundResults(pendingMessages);
    if (latestToolRoundHasUserVisibleAssistantText(pendingMessages)) {
      ensureProviderLanguageLock(pendingMessages);
    }
    let discoveredToolsets = await this.getConversationDiscoveredToolsets(user, conversationId);
    let tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
    let runtimeMessages = providerMessagesToClientMessages(pendingMessages);
    const systemPrompt = await this.buildSystemPrompt(user, pageContext, conversationId);
    const buildProviderMessages = async () => [
      { role: 'system', content: systemPrompt },
      ...(await Promise.all(runtimeMessages.map((message) => this.toProviderMessage(user, message, config)))),
    ];
    let messages = pendingMessages;

    // Continue with remaining rounds
    const maxRounds = config.maxToolRounds;
    let roundsSinceComment = 0;
    let commentRepairAttempts = 0;
    let runLanguageLocked = hasRunLanguageLock(runtimeMessages);
    while (true) {
      if (signal.aborted) return;

      if (receivePendingSteers) runtimeMessages = await receivePendingSteers(runtimeMessages);

      if (autoCompactContext) {
        try {
          const previousCompactEpoch = latestCompactEpoch(runtimeMessages);
          runtimeMessages = await autoCompactContext(runtimeMessages);
          if (latestCompactEpoch(runtimeMessages) > previousCompactEpoch) {
            discoveredToolsets = [];
            tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
          }
        } catch (error) {
          if (error instanceof AppError && error.code === 'AI_CONTEXT_TOO_LARGE') {
            yield { type: 'context_blocked', requestId, reason: error.message };
            yield { type: 'done', requestId };
            return;
          }
          throw error;
        }
      }
      if (runLanguageLocked) ensureRuntimeLanguageLock(runtimeMessages);
      const commentRequired = roundsSinceComment >= maxRounds;
      const activeTools = commentRequired ? commentToolFrom(tools) : tools;
      if (commentRequired && activeTools.length === 0) {
        messages = await buildProviderMessages();
        messages = [...messages, { role: 'system', content: TOOL_COMMENT_REQUIRED_MESSAGE }];
        assertProviderInputWithinLimits(messages, [], provider.contextLimits);
        yield* this.streamFinalTextResponse({ provider, messages, requestId, signal });
        return;
      }
      messages = await buildProviderMessages();
      messages = commentRequired ? [...messages, { role: 'system', content: TOOL_COMMENT_REQUIRED_MESSAGE }] : messages;
      assertProviderInputWithinLimits(messages, activeTools, provider.contextLimits);

      let contentBuffer = '';
      let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

      try {
        for await (const event of provider.stream(messages, activeTools)) {
          if (event.type === 'text_delta') {
            contentBuffer += event.content;
            yield {
              type: commentRequired ? 'assistant_comment_delta' : 'text_delta',
              requestId,
              content: event.content,
            };
          } else {
            contentBuffer = event.response.content;
            toolCalls = event.response.toolCalls;
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : 'Stream error';
        logger.error('AI provider error', { error: err });
        if (isContextWindowError(err)) {
          yield {
            type: 'context_blocked',
            requestId,
            reason:
              'This chat has run out of usable context and could not be compacted automatically. Clear part of the oldest context or start a new chat.',
          };
          yield { type: 'done', requestId };
          return;
        }
        yield { type: 'error', requestId, message };
        yield { type: 'done', requestId };
        return;
      }

      toolCalls = toolCalls.filter((tc) => tc.id && tc.name);
      if (toolCalls.length === 0) {
        if (commentRequired) {
          const comment = contentBuffer.trim();
          if (comment) {
            runtimeMessages.push({ role: 'assistant', content: comment });
            ensureRuntimeLanguageLock(runtimeMessages);
            runLanguageLocked = true;
            yield { type: 'assistant_comment', requestId, content: comment };
            roundsSinceComment = 0;
            commentRepairAttempts = 0;
            continue;
          }
          yield { type: 'error', requestId, message: SEND_COMMENT_EMPTY_ERROR };
          yield { type: 'done', requestId };
          return;
        }
        this.roundInlineTokens.delete(requestId);
        yield { type: 'done', requestId };
        return;
      }

      // Process tool calls
      const rawToolCalls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));

      messages.push({ role: 'assistant', content: contentBuffer || null, tool_calls: rawToolCalls });
      runtimeMessages.push({ role: 'assistant', content: contentBuffer || null, tool_calls: rawToolCalls });

      let parsedToolCalls: PendingToolCall[] = toolCalls.map((tc) => {
        const validation = parseAndValidateAIToolArguments(tc.name, tc.arguments);
        return validation.ok
          ? { ...tc, parsedArgs: validation.arguments }
          : { ...tc, parsedArgs: {}, validationError: validation.error };
      });
      if (parsedToolCalls.some((tc) => tc.name === SEND_COMMENT_TOOL_NAME)) {
        const result = this.processCommentToolCalls({ parsedToolCalls, messages, runtimeMessages, requestId });
        for (const event of result.events) yield event;
        if (result.accepted) {
          runLanguageLocked = true;
          roundsSinceComment = 0;
          commentRepairAttempts = 0;
        } else {
          commentRepairAttempts += 1;
          if (commentRepairAttempts >= SEND_COMMENT_REPAIR_LIMIT) {
            yield { type: 'error', requestId, message: SEND_COMMENT_EMPTY_ERROR };
            yield { type: 'done', requestId };
            return;
          }
        }
        continue;
      }
      this.roundInlineTokens.set(requestId, 0);
      const approvalMode = await this.resolveCurrentApprovalMode(user);
      const toolRound = createToolRoundStartEvent(requestId, parsedToolCalls, approvalMode, messages);
      yield toolRound;

      for (const tc of parsedToolCalls.filter((call) => call.validationError)) {
        const error = tc.validationError!;
        yield { type: 'tool_call_start', requestId, id: tc.id, name: tc.name, arguments: {} };
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error }) });
        runtimeMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error }) });
        yield { type: 'tool_result', requestId, id: tc.id, name: tc.name, result: undefined, error };
      }
      parsedToolCalls = parsedToolCalls.filter((call) => !call.validationError);
      if (parsedToolCalls.length === 0) continue;

      roundsSinceComment += 1;

      const questionTools2: typeof parsedToolCalls = [];
      const approvalTools2: typeof parsedToolCalls = [];
      const immediateTools2: typeof parsedToolCalls = [];

      for (const tc of parsedToolCalls) {
        if (tc.name === 'ask_question') {
          questionTools2.push(tc);
          continue;
        }
        if (getAIToolApprovalDecision(tc.name, approvalMode, tc.parsedArgs).requiresApproval) {
          approvalTools2.push(tc);
          continue;
        }
        immediateTools2.push(tc);
      }

      for (const tc of immediateTools2) {
        yield { type: 'tool_call_start', requestId, id: tc.id, name: tc.name, arguments: tc.parsedArgs };
        const result = await this.executeTool(user, tc.name, tc.parsedArgs, { pageContext, conversationId });
        if (result.credentialChallenge) {
          yield {
            type: 'credential_authorization_required',
            requestId,
            id: tc.id,
            name: tc.name,
            provider: result.credentialChallenge.provider,
            connectorId: result.credentialChallenge.connectorId,
            arguments: tc.parsedArgs,
            roundId: toolRound.roundId,
            _rawArguments: tc.parsedArgs,
            _pendingMessages: messages,
            _queuedApprovals: approvalTools2.map((approval) => ({
              id: approval.id,
              name: approval.name,
              arguments: approvalDisplayArgs(approval.name, approval.parsedArgs),
              rawArguments: approval.parsedArgs,
            })),
          } as any;
          return;
        }
        if (tc.name === 'discover_tools') {
          const activatedToolsets = discoveredToolsetsFromResult(result.result);
          if (activatedToolsets) {
            discoveredToolsets = mergeToolsets([], activatedToolsets);
            tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
          }
        }
        const resourceReferences = await this.toolResourceReferences(
          tc.name,
          tc.parsedArgs,
          result.result,
          result.error
        );
        const prepared = await this.prepareToolOutput({
          userId: user.id,
          conversationId,
          sourceRunId: requestId,
          sourceToolCallId: tc.id,
          toolName: tc.name,
          result: result.result,
          error: result.error,
          contextLimits: provider.contextLimits,
          systemPrompt,
          tools,
          resourceReferences,
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: safeStringify(prepared.modelResult),
        });
        runtimeMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: safeStringify(prepared.modelResult),
        });
        yield {
          type: 'tool_result',
          requestId,
          id: tc.id,
          name: tc.name,
          result: prepared.eventResult,
          error: prepared.error,
          clientAction: prepared.clientAction,
          resourceReferences: prepared.resourceReferences,
        };
        if (result.invalidateStores.length > 0) {
          yield { type: 'invalidate_stores', requestId, stores: result.invalidateStores };
        }
        if (shouldEndRunAfterPlanTool(tc.name, result.result, result.error)) {
          yield { type: 'done', requestId };
          return;
        }
        if (tc.name === 'end_conversation' && !result.error) {
          yield {
            type: 'conversation_ended',
            requestId,
            reason: conversationEndReason(result.result, 'This conversation has been ended.'),
          };
          yield { type: 'done', requestId };
          return;
        }
      }

      if (questionTools2.length > 0) {
        for (const tc of questionTools2) {
          yield { type: 'tool_call_start', requestId, id: tc.id, name: tc.name, arguments: tc.parsedArgs };
        }
        const first = questionTools2[0];
        yield {
          type: 'tool_approval_required',
          requestId,
          id: first.id,
          name: 'ask_question',
          arguments: first.parsedArgs,
          roundId: toolRound.roundId,
          _pendingMessages: messages,
          _allQuestions: questionTools2.map((q) => ({ id: q.id, args: q.parsedArgs })),
          _queuedApprovals: approvalTools2.map((approval) => ({
            id: approval.id,
            name: approval.name,
            arguments: approvalDisplayArgs(approval.name, approval.parsedArgs),
            rawArguments: approval.parsedArgs,
          })),
        } as any;
        return;
      }

      if (approvalTools2.length > 0) {
        const [approvalTool2, ...queued] = approvalTools2;
        yield {
          type: 'tool_call_start',
          requestId,
          id: approvalTool2.id,
          name: approvalTool2.name,
          arguments: approvalDisplayArgs(approvalTool2.name, approvalTool2.parsedArgs),
        };
        yield {
          type: 'tool_approval_required',
          requestId,
          id: approvalTool2.id,
          name: approvalTool2.name,
          arguments: approvalDisplayArgs(approvalTool2.name, approvalTool2.parsedArgs),
          roundId: toolRound.roundId,
          _rawArguments: approvalTool2.parsedArgs,
          _pendingMessages: messages,
          _queuedApprovals: queued.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: approvalDisplayArgs(tc.name, tc.parsedArgs),
            rawArguments: tc.parsedArgs,
          })),
        } as any;
        return;
      }

      if (contentBuffer.trim()) {
        ensureRuntimeLanguageLock(runtimeMessages);
        runLanguageLocked = true;
      }
    }
  }

  private async *streamFinalTextResponse(input: {
    provider: AIProviderSession;
    messages: Record<string, unknown>[];
    requestId: string;
    signal: AbortSignal;
  }): AsyncGenerator<WSServerMessage> {
    const { provider, messages, requestId } = input;
    try {
      for await (const event of provider.stream(messages, [])) {
        if (event.type === 'text_delta') {
          yield { type: 'text_delta', requestId, content: event.content };
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      const message = err instanceof Error ? err.message : 'Stream error';
      logger.error('AI provider error', { error: err });
      if (isContextWindowError(err)) {
        yield {
          type: 'context_blocked',
          requestId,
          reason:
            'This chat has run out of usable context and could not be compacted automatically. Clear part of the oldest context or start a new chat.',
        };
        yield { type: 'done', requestId };
        return;
      }
      yield { type: 'error', requestId, message };
      yield { type: 'done', requestId };
      return;
    }

    yield { type: 'done', requestId };
  }

  /**
   * Get context size estimate for /context command.
   */
  async getContextEstimate(
    user: User,
    pageContext?: PageContext,
    conversationId?: string,
    selectedModel?: string,
    selectedReasoningEffort?: string,
    clientMessages: ChatMessage[] = []
  ): Promise<{
    chatTokens: number;
    messageCount: number;
    systemTokens: number;
    toolsTokens: number;
    totalOverhead: number;
    limit: number;
    reasoningEffort: string;
    toolCount: number;
    systemBreakdown: SystemPromptBreakdownItem[];
    toolBreakdown: Array<{ label: string; chars: number; tokens: number }>;
  }> {
    const storedConfig = await this.settingsService.getConfig();
    let config = storedConfig;
    let reasoningEffort: string = storedConfig.reasoningEffort;
    let contextLimits = directProviderContextLimits(storedConfig.maxContextTokens, storedConfig.maxCompletionTokens);
    if (storedConfig.providerType === 'gateway_inference') {
      const provider = await this.resolveProviderSession(user, {
        requestId: `context-estimate:${conversationId ?? 'new'}`,
        conversationId,
        requestedModel: selectedModel,
        requestedReasoningEffort: selectedReasoningEffort,
        signal: new AbortController().signal,
      });
      config = provider.config;
      contextLimits = provider.contextLimits;
      reasoningEffort = provider.reasoningEffort ?? 'none';
    }
    const { prompt, breakdown } = await this.buildSystemPromptDetailed(user, pageContext, conversationId);
    const discoveredToolsets = mergeToolsets(
      (await this.getConversationDiscoveredToolsets(user, conversationId)) ?? [],
      inferDiscoveredToolsetsFromMessages(clientMessages)
    );
    const tools = await this.buildModelTools(config, user, discoveredToolsets, conversationId);
    const providerMessages = await Promise.all(
      clientMessages.map((message) => this.toProviderMessage(user, message, config))
    );
    const chatTokens = estimateProviderMessagesTokens(providerMessages);
    const systemTokens = estimateTextTokens(prompt);
    const toolsTokens = estimateToolSchemaTokens(tools);
    const totalOverhead = systemTokens + toolsTokens;
    const toolBreakdown = estimateToolBreakdown(tools);

    return {
      chatTokens,
      messageCount: clientMessages.length,
      systemTokens,
      toolsTokens,
      totalOverhead,
      limit: contextLimits.autoCompactTokenLimit,
      reasoningEffort,
      toolCount: tools.length,
      systemBreakdown: breakdown,
      toolBreakdown,
    };
  }
}
