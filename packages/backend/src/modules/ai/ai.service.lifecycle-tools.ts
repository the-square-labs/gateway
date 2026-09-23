import { eq } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import { nodes as nodesTable } from '@/db/schema/nodes.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { IdParamSchema } from '@/lib/openapi.js';
import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { RELEASE_VERSION_PATTERN } from '@/lib/semver.js';
import { AppError } from '@/middleware/error-handler.js';
import { AlertService } from '@/modules/audit/alert.service.js';
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
          // The update operations mirror the /system update routes step for step.
          case 'perform_gateway_update': {
            const version = releaseVersionArg(a.version);
            if (updateService.isGatewayUpdateInProgress()) {
              throw new AppError(409, 'UPDATE_IN_PROGRESS', 'A Gateway update is already in progress');
            }
            // A running Relay Pool update refuses the Gateway update.
            await updateService.assertGatewayUpdateAllowed();
            const status = await updateService.getCachedStatus();
            if (!status.updateAvailable) throw new Error('No gateway update is available');
            if (version !== status.latestVersion) throw new Error('Requested version does not match available update');
            const artifact = await updateService.prepareGatewayUpdate(version);
            // A new attempt supersedes the report of a previous rolled-back one.
            await updateService.acknowledgeGatewayUpdateFailure();
            const eventBus = container.resolve(EventBusService);
            eventBus.publish('system.update.changed', { updating: true, component: 'gateway', targetVersion: version });
            setTimeout(() => {
              updateService.performUpdate(version, artifact, user.id).catch((error) => {
                // A concurrent request lost the race; the accepted update keeps running.
                if (error instanceof AppError && error.code === 'UPDATE_IN_PROGRESS') return;
                eventBus.publish('system.update.changed', {
                  updating: false,
                  component: 'gateway',
                  targetVersion: version,
                  ...(error instanceof AppError ? { error: error.message } : {}),
                });
                logger.error('Gateway update failed from AI tool', {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                });
              });
            }, 500);
            return { status: 'updating', targetVersion: version };
          }
          case 'proceed_gateway_update': {
            if (!updateService.proceedWithoutWaiting()) {
              throw new AppError(409, 'UPDATE_NOT_WAITING', 'No Gateway update is waiting for running operations');
            }
            logger.warn('Gateway update proceeds without waiting for running operations', { userId: user.id });
            return { status: 'updating' };
          }
          case 'acknowledge_gateway_update_failure':
            return { acknowledged: await updateService.acknowledgeGatewayUpdateFailure() };
          case 'perform_relay_update': {
            const version = releaseVersionArg(a.version);
            if (updateService.isGatewayUpdateInProgress()) {
              throw new AppError(
                409,
                'GATEWAY_UPDATE_IN_PROGRESS',
                'Gateway is updating. Update the Relay Pool after the Gateway update has finished.'
              );
            }
            const status = await updateService.getCachedStatus();
            if (!status.relay.updateAvailable || !status.relay.latestVersion) {
              throw new AppError(400, 'NO_UPDATE', 'No relay update available');
            }
            if (version !== status.relay.latestVersion) {
              throw new AppError(400, 'VERSION_MISMATCH', 'Requested version does not match available relay update');
            }
            const artifact = await updateService.prepareRelayUpdate(version);
            updateService.startRelayUpdate(version);
            const eventBus = container.resolve(EventBusService);
            eventBus.publish('system.update.changed', { updating: true, component: 'relay', targetVersion: version });
            setTimeout(() => {
              updateService
                .performRelayUpdate(version, artifact, user.id)
                .then(() => updateService.completeRelayUpdate())
                .then(() => updateService.checkForUpdates())
                .then(() => {
                  eventBus.publish('system.update.changed', {
                    updating: false,
                    component: 'relay',
                    targetVersion: version,
                  });
                })
                .catch((error) => {
                  updateService.failRelayUpdate(error);
                  eventBus.publish('system.update.changed', {
                    updating: false,
                    component: 'relay',
                    targetVersion: version,
                  });
                  logger.error('Relay update failed from AI tool', {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                  });
                });
            }, 500);
            return { status: 'updating', targetVersion: version };
          }
          case 'abandon_relay_update': {
            const data = await updateService.abandonRelayUpdate(user.id);
            const eventBus = container.resolve(EventBusService);
            eventBus.publish('system.update.changed', {
              updating: false,
              component: 'relay',
              targetVersion: data.targetVersion,
              statusChanged: true,
            });
            eventBus.publish('system.relay.health.changed', { poolId: 'system', action: 'update_abandoned' });
            return data;
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

            const daemonType = node.type === 'databases' || node.type === 'storage' ? 'docker' : node.type;
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
      case 'manage_system_alerts': {
        // Same broad admin:alerts scope as the /alerts routes.
        this.ensureToolScope(user, 'admin:alerts');
        const alertService = container.resolve(AlertService);
        if (a.operation === 'list') return alertService.getAlerts();
        if (a.operation === 'dismiss') {
          const { id } = IdParamSchema.parse({ id: a.alertId });
          await alertService.dismissAlert(id);
          return { success: true, message: 'Alert dismissed' };
        }
        throw new Error(`Unsupported system alert operation: ${String(a.operation)}`);
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

      case 'enter_plan_mode':
      case 'submit_plan':
      case 'submit_plan_review':
      case 'start_plan_execution':
      case 'update_plan_step':
      case 'pause_plan_execution':
      case 'resume_plan_execution':
      case 'finalize_plan_execution':
      case 'submit_plan_verification': {
        const planning = container.isRegistered(TOKENS.CommercialEdition)
          ? container.resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition).planning
          : undefined;
        if (!planning) return commercialModuleUnavailable();
        return planning.executeTool(this.planService, user, toolName, args, runtimeContext.conversationId);
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

function releaseVersionArg(value: unknown): string {
  const version = String(value ?? '');
  if (!RELEASE_VERSION_PATTERN.test(version)) throw new AppError(400, 'INVALID_VERSION', 'Invalid version format');
  return version;
}
