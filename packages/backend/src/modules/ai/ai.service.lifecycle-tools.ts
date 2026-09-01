import { eq } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import { nodes as nodesTable } from '@/db/schema/nodes.js';
import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { UpdateService } from '@/services/update.service.js';
import type { User } from '@/types.js';
import { manageDockerContainerConfigTool } from './ai.docker-config-tools.js';
import { getInternalDocumentation } from './ai.docs.js';
import { manageLoggingTool } from './ai.logging-tools.js';
import { AIServiceAdministrationTools } from './ai.service.administration-tools.js';
import { logger, type ToolRuntimeContext, UNHANDLED_TOOL } from './ai.service.runtime-helpers.js';
import { agentPage, agentPageLimit, dashboardStatsOptionsForScopes } from './ai.service-helpers.js';
import { manageStatusPageTool } from './ai.status-page-tools.js';
import { executeWebSearch } from './ai.web-search.js';

export class AIServiceLifecycleTools extends AIServiceAdministrationTools {
  protected async executeLifecycleTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext
  ): Promise<unknown> {
    const a = args as any;
    switch (toolName) {
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
            const operationId = await daemonUpdateService.markNodeUpdateInProgress(nodeId, release.version);
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
              daemonUpdateService.trackNodeUpdateCompletion(nodeId, operationId, command.result);
              await command.accepted;
            } catch (error) {
              await daemonUpdateService.clearNodeUpdateInProgress(nodeId, operationId);
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
      case 'read_gateway_documentation':
        return getInternalDocumentation(a.topic, [...user.scopes, 'mcp:use']);

      // ── Web Search ──
      case 'web_search':
        return executeWebSearch(this.settingsService, a.query, a.maxResults || 5);

      default:
        return UNHANDLED_TOOL;
    }
  }
}
