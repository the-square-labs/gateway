import { container } from '@/container.js';
import { boundScopes } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { getAuditRequestContext, setAuditMcpContext } from '@/modules/audit/audit-request-context.js';
import { requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { User } from '@/types.js';
import { ACCESS_LIST_TOOL_NAMES, executeAccessListTool } from './ai.access-list-tools.js';
import { DATABASE_TOOL_NAMES, executeDatabaseTool } from './ai.database-tools.js';
import { DOCKER_TOOL_NAMES, executeDockerTool } from './ai.docker-tools.js';
import { DOMAIN_TOOL_NAMES, executeDomainTool } from './ai.domain-tools.js';
import { executeFolderTool, FOLDER_TOOL_NAMES } from './ai.folder-tools.js';
import { executeGitLabTool, GITLAB_TOOL_NAMES } from './ai.gitlab-tools.js';
import { executeGroupTool, GROUP_TOOL_NAMES } from './ai.group-tools.js';
import { executeInferenceTool, INFERENCE_TOOL_NAMES } from './ai.inference-tools.js';
import { executeIntegrationTool, INTEGRATION_TOOL_NAMES } from './ai.integration-tools.js';
import { executeNodeTool, NODE_TOOL_NAMES } from './ai.node-tools.js';
import {
  executeNotificationTool,
  NOTIFICATION_TOOL_NAMES,
  SIEM_NOTIFICATION_TOOL_NAMES,
} from './ai.notification-tools.js';
import { executePkiCaTool, PKI_CA_TOOL_NAMES } from './ai.pki-ca-tools.js';
import { executePkiCertificateTool, PKI_CERTIFICATE_TOOL_NAMES } from './ai.pki-certificate-tools.js';
import { executePkiTemplateTool, PKI_TEMPLATE_TOOL_NAMES } from './ai.pki-template-tools.js';
import { executeProxyTool, PROXY_TOOL_NAMES } from './ai.proxy-tools.js';
import { executeResourceSetupTool, RESOURCE_SETUP_TOOL_NAMES } from './ai.resource-setup-tools.js';
import {
  isRecord,
  isToolAllowedForPlanState,
  logger,
  SANDBOX_TOOL_NAMES,
  type ToolRuntimeContext,
  UNHANDLED_TOOL,
} from './ai.service.runtime-helpers.js';
import { AIServiceRuntimeSupport } from './ai.service.runtime-support.js';
import { redactArgsForTool } from './ai.service.tool-helpers.js';
import { getToolResourceId, hasToolExecutionScope, isMutatingTool } from './ai.service-helpers.js';
import { executeSshTool, SSH_TOOL_NAMES } from './ai.ssh-tools.js';
import { AI_TOOLS, TOOL_STORE_INVALIDATION_MAP } from './ai.tools.js';
import type { ToolExecutionOptions, ToolExecutionResult } from './ai.types.js';
import {
  publishToolStoreInvalidation,
  resolveToolStoreInvalidations,
  toolInvalidationContext,
} from './ai-tool-store-invalidation.js';

export abstract class AIServiceExecution extends AIServiceRuntimeSupport {
  protected abstract executeInteractionTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext
  ): Promise<unknown>;
  protected abstract executeAdministrationTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext
  ): Promise<unknown>;
  protected abstract executeLifecycleTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext
  ): Promise<unknown>;

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
    if (toolDef.mcpOnly && options.source !== 'mcp') {
      return { error: `Tool ${toolName} is available only through remote MCP`, invalidateStores: [] };
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
      const invalidateStores = resolveToolStoreInvalidations(
        toolName,
        args,
        TOOL_STORE_INVALIDATION_MAP[toolName] || []
      );
      await this.persistToolRuntimeState(user, options, toolName, result);

      publishToolStoreInvalidation(this.eventBus, {
        userId: user.id,
        source,
        toolName,
        stores: invalidateStores,
        resourceId: getToolResourceId(toolDef, args),
        context: toolInvalidationContext(args),
      });

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

  protected async executeSandboxTool(
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
  protected async executeToolInternal(
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
      if (SIEM_NOTIFICATION_TOOL_NAMES.has(toolName)) {
        // LICENSE ENFORCEMENT: AI/MCP callers cannot bypass the Enterprise SIEM entitlement.
        await requireConfiguredLicensePolicy(this.licensePolicyService).requireFeature('siem-export');
      }
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
      // LICENSE ENFORCEMENT: AI/MCP callers cannot bypass the Enterprise PKI entitlement.
      await requireConfiguredLicensePolicy(this.licensePolicyService).requireFeature('internal-pki');
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
      // LICENSE ENFORCEMENT: AI/MCP callers cannot bypass the Enterprise PKI entitlement.
      await requireConfiguredLicensePolicy(this.licensePolicyService).requireFeature('internal-pki');
      return executePkiCaTool({ caService: this.caService }, user, toolName, args);
    }
    if (PKI_CERTIFICATE_TOOL_NAMES.has(toolName)) {
      // LICENSE ENFORCEMENT: AI/MCP callers cannot bypass the Enterprise PKI entitlement.
      if (toolName !== 'audit_system_pki_leaves') {
        await requireConfiguredLicensePolicy(this.licensePolicyService).requireFeature('internal-pki');
      }
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

    const interactionResult = await this.executeInteractionTool(user, toolName, args, runtimeContext);
    if (interactionResult !== UNHANDLED_TOOL) return interactionResult;
    const administrationResult = await this.executeAdministrationTool(user, toolName, args, runtimeContext);
    if (administrationResult !== UNHANDLED_TOOL) return administrationResult;
    const lifecycleResult = await this.executeLifecycleTool(user, toolName, args, runtimeContext);
    if (lifecycleResult !== UNHANDLED_TOOL) return lifecycleResult;
    throw new Error(`Tool not implemented: ${toolName}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}
