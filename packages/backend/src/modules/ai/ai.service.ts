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
import { manageLoggingTool } from './ai.logging-tools.js';
import { executeNodeTool, NODE_TOOL_NAMES } from './ai.node-tools.js';
import { executeNotificationTool, NOTIFICATION_TOOL_NAMES } from './ai.notification-tools.js';
import { executePkiCaTool, PKI_CA_TOOL_NAMES } from './ai.pki-ca-tools.js';
import { executePkiCertificateTool, PKI_CERTIFICATE_TOOL_NAMES } from './ai.pki-certificate-tools.js';
import { executePkiTemplateTool, PKI_TEMPLATE_TOOL_NAMES } from './ai.pki-template-tools.js';
import { streamModelResponse } from './ai.provider-adapter.js';
import { executeProxyTool, PROXY_TOOL_NAMES } from './ai.proxy-tools.js';
import { findResource } from './ai.resource-search.js';
import type { AISandboxService } from './ai.sandbox.service.js';
import type { AISandboxArtifactService } from './ai.sandbox-artifact.service.js';
import {
  agentPage,
  agentPageLimit,
  allowedResourceIdsForScopes,
  compactProxyHostForAgent,
  dashboardStatsOptionsForScopes,
  estimateMessagesTokens,
  estimateTokens,
  getToolResourceId,
  hasToolExecutionScope,
  isMutatingTool,
  redactToolArgs,
  trimToTokenBudget,
} from './ai.service-helpers.js';
import type { AISettingsService } from './ai.settings.service.js';
import { manageStatusPageTool } from './ai.status-page-tools.js';
import { buildAISystemPromptDetailed, type SystemPromptBreakdownItem } from './ai.system-prompt.js';
import { AI_TOOLS, getOpenAITools, inferDiscoveredToolsetsFromText, TOOL_STORE_INVALIDATION_MAP } from './ai.tools.js';
import type {
  AIMessageAttachment,
  ChatMessage,
  PageContext,
  ToolExecutionOptions,
  ToolExecutionResult,
  WSServerMessage,
} from './ai.types.js';
import { executeWebSearch } from './ai.web-search.js';
import { getAIToolApprovalDecision } from './ai-approval-policy.js';
import { AIConversationService } from './ai-conversation.service.js';
import { type AIChatSearchScope, AIConversationSearchService } from './ai-conversation-search.service.js';
import type { AIProviderRuntimeService, AIProviderSession } from './ai-provider-runtime.service.js';
import { redactOneTimeSecretToolResult } from './ai-secret-result-redaction.js';

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

type ToolRuntimeContext = {
  pageContext?: PageContext;
  conversationId?: string;
};

export type AIContextCompactionTrigger = 'manual' | 'auto';

export interface AIContextCompactionResult {
  compacted: boolean;
  summary: string;
  compactedMessageCount: number;
  tailMessageCount: number;
  omittedSourceChars: number;
  trigger: AIContextCompactionTrigger;
}

const COMPACTION_TAIL_MESSAGES = 8;
const COMPACTION_AUTO_THRESHOLD = 0.86;
const COMPACTION_SOURCE_RESERVE_TOKENS = 6000;
const SEND_COMMENT_TOOL_NAME = 'send_comment';
const TOOL_COMMENT_REQUIRED_MESSAGE =
  'You have reached the maximum number of sequential tool-call rounds without a user-visible progress comment. Call only send_comment now with a concise, useful progress update in the user language, then continue the task after that comment. Do not call any other tool in this response.';
const SEND_COMMENT_EMPTY_ERROR =
  'send_comment requires a real, non-empty progress comment for the user. Call send_comment again with a concise update in the user language.';
const SEND_COMMENT_MIXED_ERROR =
  'send_comment must be called by itself. First send the progress comment, then call other tools in the next assistant turn.';
const SEND_COMMENT_REPAIR_LIMIT = 3;

type ModelTool = ReturnType<typeof getOpenAITools>[number];
type PendingToolCall = { id: string; name: string; arguments: string; parsedArgs: Record<string, unknown> };

function messageBudgetForTools(maxContextTokens: number, tools: unknown[]): number {
  return Math.max(1, maxContextTokens - estimateTokens(safeStringify(tools)));
}

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
  if (toolName === 'get_docker_container_logs') return compactLogLikeResult(value, 'Docker container logs');
  if (toolName === 'send_artifact' && isRecord(value)) {
    const { artifactId, filename, mediaType, sizeBytes, sourcePath, downloadUrl } = value;
    return { artifactId, filename, mediaType, sizeBytes, sourcePath, downloadUrl };
  }
  if ((toolName === 'fetch' || toolName === 'read_artifact') && isRecord(value)) {
    const content = typeof value.content === 'string' ? value.content : undefined;
    if (content && content.length > 4000) {
      return {
        ...value,
        content: undefined,
        contentPreview: content.slice(0, 2000),
        contentOmitted: true,
      };
    }
  }
  if (toolName === 'manage_logging' && isRecord(value) && Array.isArray(value.rows)) {
    return compactLogLikeResult(value.rows, 'Structured log search results');
  }
  if (typeof value === 'string' && value.length > 4000) {
    return compactLogText(value, 'Large text tool output');
  }
  if (Array.isArray(value) && value.length > 25) {
    return {
      summary: `Large array tool output omitted from model context (${value.length} items).`,
      count: value.length,
      sample: [...value.slice(0, 5), ...value.slice(-5)],
      fullOutputOmitted: true,
    };
  }
  return value;
}

function compactLogLikeResult(value: unknown, label: string): unknown {
  if (typeof value === 'string') return compactLogText(value, label);
  if (!Array.isArray(value)) return value;
  return {
    summary: `${label} omitted from model context (${value.length} entries).`,
    count: value.length,
    sample: [...value.slice(0, 3), ...value.slice(-5)],
    fullOutputOmitted: true,
  };
}

function compactLogText(value: string, label: string): unknown {
  const lines = value.split(/\r?\n/).filter(Boolean);
  return {
    summary: `${label} omitted from model context (${lines.length} lines, ${value.length} chars).`,
    lineCount: lines.length,
    sample: [...lines.slice(0, 3), ...lines.slice(-5)],
    fullOutputOmitted: true,
  };
}

function selectCompactionSource(messages: ChatMessage[]): { source: ChatMessage[]; tail: ChatMessage[] } {
  if (messages.length <= COMPACTION_TAIL_MESSAGES + 1) {
    return { source: [], tail: messages };
  }
  const splitAt = Math.max(1, messages.length - COMPACTION_TAIL_MESSAGES);
  return {
    source: messages.slice(0, splitAt),
    tail: messages.slice(splitAt),
  };
}

function providerMessagesToClientMessages(messages: Record<string, unknown>[]): ChatMessage[] {
  return messages.map(providerMessageToClientMessage).filter((message): message is ChatMessage => message !== null);
}

function providerMessageToClientMessage(message: Record<string, unknown>): ChatMessage | null {
  const role = message.role;
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
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      const attachments = message.attachments?.length
        ? `\nAttachments: ${message.attachments.map((attachment) => attachment.filename).join(', ')}`
        : '';
      const toolCalls = message.tool_calls?.length
        ? `\nTool calls: ${message.tool_calls
            .map((toolCall) => `${toolCall.function.name}(${toolCall.function.arguments || '{}'})`)
            .join('\n')}`
        : '';
      return `${heading}\n${content}${attachments}${toolCalls}`;
    })
    .join('\n\n---\n\n');
}

function limitCompactionSourceText(value: string, maxChars: number): { text: string; omittedChars: number } {
  if (value.length <= maxChars) return { text: value, omittedChars: 0 };
  const headChars = Math.floor(maxChars * 0.45);
  const tailChars = Math.floor(maxChars * 0.45);
  const omittedChars = value.length - headChars - tailChars;
  return {
    text: `${value.slice(0, headChars)}\n\n[... ${omittedChars} chars omitted from the middle of compaction source ...]\n\n${value.slice(
      -tailChars
    )}`,
    omittedChars,
  };
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

function buildCompactionUserPrompt(input: {
  sourceText: string;
  tailText: string;
  sourceMessageCount: number;
  tailMessageCount: number;
  omittedSourceChars: number;
}): string {
  return [
    `Summarize the older chat context below. ${input.tailMessageCount} latest messages are intentionally kept verbatim and are not included here.`,
    input.tailText
      ? `Use this latest preserved tail only to infer the active language, tone, and immediate continuity. Do not repeat it in the summary:\n\n${input.tailText}`
      : '',
    input.omittedSourceChars > 0
      ? `${input.omittedSourceChars} characters from the middle of the source were omitted before summarization because the source was too large.`
      : '',
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
  return [...new Set([...existing, ...added].map((toolset) => toolset.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function discoveredToolsetsFromResult(value: unknown): string[] {
  return isRecord(value) && Array.isArray(value.discoveredToolsets)
    ? value.discoveredToolsets.filter((toolset): toolset is string => typeof toolset === 'string')
    : [];
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
    current.tokens += estimateTokens(serialized);
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
    private readonly generalSettingsService?: import('@/modules/settings/general-settings.service.js').GeneralSettingsService
  ) {}

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
    const client = new OpenAI({ apiKey, baseURL: config.providerUrl || undefined });
    return {
      config,
      reasoningEffort: config.reasoningEffort === 'none' ? null : config.reasoningEffort,
      stream: (messages, tools) => streamModelResponse({ client, config, messages, tools, signal: options.signal }),
    };
  }

  private async getAdminInferenceModels() {
    return this.providerRuntimeService ? this.providerRuntimeService.adminModels() : [];
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
    return buildAISystemPromptDetailed(
      {
        settingsService: this.settingsService,
        monitoringService: this.monitoringService,
        caService: this.caService,
        retrievalPointers,
      },
      user,
      pageContext
    );
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

    let executionUser = options.scopes ? { ...user, scopes: options.scopes } : user;
    if (options.source === 'mcp') {
      try {
        const currentUser = await this.authService.getUserById(user.id);
        if (!currentUser || currentUser.isBlocked) {
          return {
            error: 'PERMISSION_DENIED: Your current account access no longer allows this action.',
            invalidateStores: [],
          };
        }
        executionUser = { ...currentUser, scopes: boundScopes(options.scopes ?? [], currentUser.scopes) };
      } catch (error) {
        logger.warn('Failed to refresh current access before MCP tool execution', { userId: user.id, error });
        return {
          error: 'PERMISSION_DENIED: Current account access could not be verified.',
          invalidateStores: [],
        };
      }
    }

    // Permission check — tools with empty requiredScope are blocked (must be explicit)
    if (!hasToolExecutionScope(executionUser.scopes, toolName, toolDef.requiredScope, args)) {
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
      resourceId: getToolResourceId(args),
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
      if (source === 'ai' && err instanceof AppError && err.code === 'GITLAB_CREDENTIAL_REQUIRED') {
        const details = isRecord(err.details) ? err.details : {};
        if (typeof details.connectorId === 'string') {
          return {
            credentialChallenge: { provider: 'gitlab', connectorId: details.connectorId },
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

    if (DATABASE_TOOL_NAMES.has(toolName)) {
      return executeDatabaseTool({ databaseService: this.databaseService }, user, toolName, args);
    }
    if (INFERENCE_TOOL_NAMES.has(toolName)) {
      return executeInferenceTool(user, toolName, args);
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
        return this.discoverTools(user, args);

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
        return this.sslService.requestACMECert(RequestACMECertSchema.parse(args), user.id);
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
        if (!host) throw new Error('Proxy host not found');
        const renderedConfig = await this.proxyService.getRenderedConfig(a.proxyHostId);
        return { proxyHostId: a.proxyHostId, config: renderedConfig };
      }
      case 'update_proxy_raw_config': {
        const rawHost = await this.proxyService.getProxyHost(a.proxyHostId);
        if (!rawHost) throw new Error('Proxy host not found');
        if (!(rawHost as any).rawConfigEnabled) {
          throw new Error('Raw mode is not enabled on this proxy host. Enable it first with toggle_proxy_raw_mode.');
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
              const result = await container
                .resolve(NodeDispatchService)
                .sendUpdateDaemonCommand(
                  nodeId,
                  artifact.downloadUrl,
                  release.version,
                  artifact.checksum,
                  artifact.signedManifest
                );
              if (!result.success) {
                await daemonUpdateService.clearNodeUpdateInProgress(nodeId);
                throw new Error(result.error || 'Failed to start daemon update');
              }
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

      case 'manage_docker_container_config':
        return manageDockerContainerConfigTool({ dockerService: this.dockerService }, user, args);

      case 'manage_logging':
        return manageLoggingTool(user, args);
      case 'manage_status_page':
        return manageStatusPageTool(user, args);

      // ── Ask Question (handled client-side, backend just passes through) ──
      case 'ask_question':
        return { _askQuestion: true, question: a.question, options: a.options, allowFreeText: a.allowFreeText };

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
      },
      user,
      args
    );
  }

  private async discoverTools(user: User, args: Record<string, unknown>) {
    const config = await this.settingsService.getConfig();
    const callableNames = new Set(
      getOpenAITools(config.disabledTools, user.scopes, config.webSearchEnabled, {
        sandboxEnabled: config.sandboxEnabled,
      }).map((tool) => tool.function.name)
    );
    const categoryFilter = stringArg(args.category)?.toLowerCase();
    const query = stringArg(args.query)?.toLowerCase();
    const includeTools = boolArg(args.includeTools) || !!categoryFilter || !!query;

    const callableTools = AI_TOOLS.filter((tool) => callableNames.has(tool.name));
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

    const tools = includeTools
      ? callableTools
          .filter((tool) => {
            if (categoryFilter && tool.category.toLowerCase() !== categoryFilter) return false;
            if (!query) return true;
            return [tool.name, tool.category, tool.description, tool.requiredScope]
              .join(' ')
              .toLowerCase()
              .includes(query);
          })
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
      categories,
      tools,
      discoveredToolsets: includeTools
        ? [...new Set((tools ?? []).map((tool) => tool.category))].sort((a, b) => a.localeCompare(b))
        : [],
      totalCallableTools: callableTools.length,
      note: includeTools
        ? 'Call the selected tool with its documented parameters. Use internal_documentation for workflow details when needed.'
        : 'Pass category, query, or includeTools:true to inspect callable tool details.',
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

  private buildModelTools(
    config: { disabledTools: string[]; webSearchEnabled: boolean; sandboxEnabled: boolean },
    user: User,
    discoveredToolsets: string[]
  ) {
    return getOpenAITools(config.disabledTools, user.scopes, config.webSearchEnabled, {
      discoveredToolsets,
      sandboxEnabled: config.sandboxEnabled,
    });
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

    if (!options.pageContext && (!discoveredToolsets || discoveredToolsets.length === 0)) return;

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
    if (!conversationId || discoveredToolsets.length === 0) return;
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
    const msg: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.role === 'user' && config.supportsImages && message.attachments?.length && this.artifactService) {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content) parts.push({ type: 'text', text: message.content });
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
    if (selectCompactionSource(clientMessages).source.length === 0) return false;

    let config: Awaited<ReturnType<AISettingsService['getConfig']>>;
    try {
      config = (
        await this.resolveProviderSession(user, {
          requestId: `context-estimate:${conversationId ?? 'new'}`,
          conversationId,
          requestedModel: selectedModel,
          requestedReasoningEffort: selectedReasoningEffort,
          signal: new AbortController().signal,
        })
      ).config;
    } catch {
      return false;
    }
    const systemPrompt = await this.buildSystemPrompt(user, pageContext, conversationId);
    const discoveredToolsets = mergeToolsets(
      (await this.getConversationDiscoveredToolsets(user, conversationId)) ?? [],
      inferDiscoveredToolsetsFromMessages(clientMessages)
    );
    const tools = this.buildModelTools(config, user, discoveredToolsets);
    const providerMessages = [
      { role: 'system', content: systemPrompt },
      ...clientMessages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.name ? { name: message.name } : {}),
      })),
    ];
    const toolsTokens = estimateTokens(safeStringify(tools));
    const messageBudget = Math.max(1, config.maxContextTokens - toolsTokens);
    const totalTokens = estimateMessagesTokens(providerMessages) + toolsTokens;
    if (totalTokens < config.maxContextTokens * COMPACTION_AUTO_THRESHOLD) return false;

    return trimToTokenBudget(providerMessages, messageBudget).length < providerMessages.length;
  }

  async compactConversationContext(
    user: User,
    clientMessages: ChatMessage[],
    _pageContext: PageContext | undefined,
    signal: AbortSignal,
    trigger: AIContextCompactionTrigger,
    selectedModel?: string,
    conversationId?: string,
    selectedReasoningEffort?: string
  ): Promise<AIContextCompactionResult> {
    const { source, tail } = selectCompactionSource(clientMessages);
    if (source.length === 0) {
      return {
        compacted: false,
        summary: 'There is not enough older context to compact yet.',
        compactedMessageCount: 0,
        tailMessageCount: tail.length,
        omittedSourceChars: 0,
        trigger,
      };
    }

    const provider = await this.resolveProviderSession(user, {
      requestId: `compact:${conversationId ?? 'new'}`,
      conversationId,
      requestedModel: selectedModel,
      requestedReasoningEffort: selectedReasoningEffort,
      signal,
      isCompaction: true,
    });
    const { config } = provider;

    const rawSourceText = serializeMessagesForCompaction(source);
    const rawTailText = serializeMessagesForCompaction(tail);
    const maxSourceChars = Math.max(8000, (config.maxContextTokens - COMPACTION_SOURCE_RESERVE_TOKENS) * 4);
    const { text: sourceText, omittedChars } = limitCompactionSourceText(rawSourceText, maxSourceChars);
    const { text: tailText } = limitCompactionSourceText(rawTailText, 4000);
    const messages = [
      { role: 'system', content: buildCompactionSystemPrompt(trigger) },
      {
        role: 'user',
        content: buildCompactionUserPrompt({
          sourceText,
          tailText,
          sourceMessageCount: source.length,
          tailMessageCount: tail.length,
          omittedSourceChars: omittedChars,
        }),
      },
    ];

    let summary = '';
    for await (const event of provider.stream(messages, [])) {
      if (event.type === 'text_delta') {
        summary += event.content;
      } else {
        summary = event.response.content;
      }
    }

    const cleanedSummary =
      summary.trim() || 'Older context was compacted, but the compaction model returned an empty summary.';
    return {
      compacted: true,
      summary: cleanedSummary,
      compactedMessageCount: source.length,
      tailMessageCount: tail.length,
      omittedSourceChars: omittedChars,
      trigger,
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
    selectedReasoningEffort?: string
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
    let discoveredToolsets = mergeToolsets(
      (await this.getConversationDiscoveredToolsets(user, conversationId)) ?? [],
      inferredToolsets
    );
    if (inferredToolsets.length > 0) {
      await this.persistInferredToolsets(user, conversationId, inferredToolsets);
    }
    let tools = this.buildModelTools(config, user, discoveredToolsets);

    let runtimeMessages = clientMessages.filter((message) => message.role !== 'system');
    const buildProviderMessages = async () => [
      { role: 'system', content: systemPrompt },
      ...(await Promise.all(runtimeMessages.map((message) => this.toProviderMessage(user, message, config)))),
    ];
    let messages: Record<string, unknown>[] = [];

    const maxContextTokens = config.maxContextTokens;
    const maxRounds = config.maxToolRounds;
    let roundsSinceComment = 0;
    let commentRepairAttempts = 0;

    while (true) {
      if (signal.aborted) return;

      if (autoCompactContext) {
        runtimeMessages = await autoCompactContext(runtimeMessages);
      }
      const commentRequired = roundsSinceComment >= maxRounds;
      const activeTools = commentRequired ? commentToolFrom(tools) : tools;
      if (commentRequired && activeTools.length === 0) {
        messages = await buildProviderMessages();
        messages = trimToTokenBudget(
          [...messages, { role: 'system', content: TOOL_COMMENT_REQUIRED_MESSAGE }],
          maxContextTokens
        );
        yield* this.streamFinalTextResponse({ provider, messages, requestId, signal });
        return;
      }
      messages = await buildProviderMessages();
      messages = trimToTokenBudget(
        commentRequired ? [...messages, { role: 'system', content: TOOL_COMMENT_REQUIRED_MESSAGE }] : messages,
        messageBudgetForTools(maxContextTokens, activeTools)
      );

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
      const parsedToolCalls = toolCalls.map((tc) => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.arguments || '{}');
        } catch {
          /* empty */
        }
        return { ...tc, parsedArgs };
      });

      if (parsedToolCalls.some((tc) => tc.name === SEND_COMMENT_TOOL_NAME)) {
        const result = this.processCommentToolCalls({ parsedToolCalls, messages, runtimeMessages, requestId });
        for (const event of result.events) yield event;
        if (result.accepted) {
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

      roundsSinceComment += 1;

      // Separate questions, tools that require approval, and immediate tools.
      const questionTools: typeof parsedToolCalls = [];
      const approvalTools: typeof parsedToolCalls = [];

      for (const tc of parsedToolCalls) {
        if (tc.name === 'ask_question') {
          questionTools.push(tc);
          continue;
        }
        if (getAIToolApprovalDecision(tc.name, user.aiApprovalMode).requiresApproval) {
          approvalTools.push(tc);
          continue;
        }

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
          discoveredToolsets = mergeToolsets(discoveredToolsets ?? [], discoveredToolsetsFromResult(result.result));
          tools = this.buildModelTools(config, user, discoveredToolsets);
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result.error || compactToolResultForModel(tc.name, result.result)),
        });
        runtimeMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result.error || compactToolResultForModel(tc.name, result.result)),
        });
        yield {
          type: 'tool_result',
          requestId,
          id: tc.id,
          name: tc.name,
          result: result.result,
          error: result.error,
        };
        if (result.invalidateStores.length > 0) {
          yield { type: 'invalidate_stores', requestId, stores: result.invalidateStores };
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
          _pendingMessages: messages,
          _allQuestions: questionTools.map((q) => ({ id: q.id, args: q.parsedArgs })),
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
    selectedReasoningEffort?: string
  ): AsyncGenerator<WSServerMessage> {
    if (toolName === 'ask_question') {
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
      };
    } else {
      const result = await this.executeTool(user, toolName, toolArgs, { pageContext, conversationId });
      if (result.credentialChallenge) {
        yield {
          type: 'credential_authorization_required',
          requestId,
          id: toolCallId,
          name: toolName,
          provider: result.credentialChallenge.provider,
          connectorId: result.credentialChallenge.connectorId,
          arguments: approvalDisplayArgs(toolName, toolArgs),
          _rawArguments: toolArgs,
          _pendingMessages: pendingMessages,
          _queuedApprovals: queuedApprovalDisplayArgs(queuedApprovals),
        } as any;
        return;
      }
      pendingMessages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: JSON.stringify(result.error || compactToolResultForModel(toolName, result.result)),
      });
      yield {
        type: 'tool_result',
        requestId,
        id: toolCallId,
        name: toolName,
        result: result.result,
        error: result.error,
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

    if (queuedApprovals.length > 0) {
      const [nextApproval, ...remainingApprovals] = queuedApprovals;
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

    let discoveredToolsets = await this.getConversationDiscoveredToolsets(user, conversationId);
    let tools = this.buildModelTools(config, user, discoveredToolsets);
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
    while (true) {
      if (signal.aborted) return;

      if (autoCompactContext) {
        runtimeMessages = await autoCompactContext(runtimeMessages);
      }
      const commentRequired = roundsSinceComment >= maxRounds;
      const activeTools = commentRequired ? commentToolFrom(tools) : tools;
      if (commentRequired && activeTools.length === 0) {
        messages = await buildProviderMessages();
        messages = trimToTokenBudget(
          [...messages, { role: 'system', content: TOOL_COMMENT_REQUIRED_MESSAGE }],
          config.maxContextTokens
        );
        yield* this.streamFinalTextResponse({ provider, messages, requestId, signal });
        return;
      }
      messages = await buildProviderMessages();
      messages = trimToTokenBudget(
        commentRequired ? [...messages, { role: 'system', content: TOOL_COMMENT_REQUIRED_MESSAGE }] : messages,
        messageBudgetForTools(config.maxContextTokens, activeTools)
      );

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
            yield { type: 'assistant_comment', requestId, content: comment };
            roundsSinceComment = 0;
            commentRepairAttempts = 0;
            continue;
          }
          yield { type: 'error', requestId, message: SEND_COMMENT_EMPTY_ERROR };
          yield { type: 'done', requestId };
          return;
        }
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

      const parsedToolCalls = toolCalls.map((tc) => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.arguments || '{}');
        } catch {
          /* empty */
        }
        return { ...tc, parsedArgs };
      });

      if (parsedToolCalls.some((tc) => tc.name === SEND_COMMENT_TOOL_NAME)) {
        const result = this.processCommentToolCalls({ parsedToolCalls, messages, runtimeMessages, requestId });
        for (const event of result.events) yield event;
        if (result.accepted) {
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

      roundsSinceComment += 1;

      const questionTools2: typeof parsedToolCalls = [];
      const approvalTools2: typeof parsedToolCalls = [];

      for (const tc of parsedToolCalls) {
        if (tc.name === 'ask_question') {
          questionTools2.push(tc);
          continue;
        }
        if (getAIToolApprovalDecision(tc.name, user.aiApprovalMode).requiresApproval) {
          approvalTools2.push(tc);
          continue;
        }

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
          discoveredToolsets = mergeToolsets(discoveredToolsets ?? [], discoveredToolsetsFromResult(result.result));
          tools = this.buildModelTools(config, user, discoveredToolsets);
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result.error || compactToolResultForModel(tc.name, result.result)),
        });
        runtimeMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result.error || compactToolResultForModel(tc.name, result.result)),
        });
        yield {
          type: 'tool_result',
          requestId,
          id: tc.id,
          name: tc.name,
          result: result.result,
          error: result.error,
        };
        if (result.invalidateStores.length > 0) {
          yield { type: 'invalidate_stores', requestId, stores: result.invalidateStores };
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
          _pendingMessages: messages,
          _allQuestions: questionTools2.map((q) => ({ id: q.id, args: q.parsedArgs })),
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
    selectedReasoningEffort?: string
  ): Promise<{
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
    if (storedConfig.providerType === 'gateway_inference') {
      const provider = await this.resolveProviderSession(user, {
        requestId: `context-estimate:${conversationId ?? 'new'}`,
        conversationId,
        requestedModel: selectedModel,
        requestedReasoningEffort: selectedReasoningEffort,
        signal: new AbortController().signal,
      });
      config = provider.config;
      reasoningEffort = provider.reasoningEffort ?? 'none';
    }
    const { prompt, breakdown } = await this.buildSystemPromptDetailed(user, pageContext, conversationId);
    const discoveredToolsets = await this.getConversationDiscoveredToolsets(user, conversationId);
    const tools = this.buildModelTools(config, user, discoveredToolsets);
    const systemTokens = estimateTokens(prompt);
    const toolsTokens = estimateTokens(safeStringify(tools));
    const totalOverhead = systemTokens + toolsTokens;
    const toolBreakdown = estimateToolBreakdown(tools);

    return {
      systemTokens,
      toolsTokens,
      totalOverhead,
      limit: config.maxContextTokens,
      reasoningEffort,
      toolCount: tools.length,
      systemBreakdown: breakdown,
      toolBreakdown,
    };
  }
}
