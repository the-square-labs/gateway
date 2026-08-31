import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { hasScope } from '@/lib/permissions.js';
import { RELEASE_VERSION_PATTERN } from '@/lib/semver.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScope, sessionOnly } from '@/modules/auth/auth.middleware.js';
import { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { DaemonUpdateService, daemonTypeForNodeType } from '@/services/daemon-update.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { RelayPoolService } from '@/services/relay-pool.service.js';
import { RelaySupervisorService } from '@/services/relay-supervisor.service.js';
import { UpdateService } from '@/services/update.service.js';
import type { AppEnv } from '@/types.js';
import {
  checkDaemonUpdatesRoute,
  checkSystemUpdateRoute,
  daemonUpdatesRoute,
  performRelayUpdateRoute,
  performSystemUpdateRoute,
  releaseNotesForVersionRoute,
  releaseNotesRoute,
  systemConfigRoute,
  systemVersionRoute,
  updateDaemonRoute,
} from './system.docs.js';

const logger = createChildLogger('SystemRoutes');

export const systemRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

systemRoutes.use('*', authMiddleware);

function requireUpdateScope(c: any) {
  if (!hasScope(c.get('effectiveScopes') || [], 'admin:update')) {
    return c.json({ message: 'Missing required scope: admin:update' }, 403);
  }
  return null;
}

// GET /version — current version + cached update status (any authenticated user)
systemRoutes.openapi(systemVersionRoute, async (c) => {
  const updateService = container.resolve(UpdateService);
  const status = await updateService.getCachedStatus();
  return c.json({ data: status });
});

systemRoutes.openapi(systemConfigRoute, async (c) => {
  const service = container.resolve(GeneralSettingsService);
  const loggingFeature = container.resolve(LoggingFeatureService);
  const config = await service.getConfig();
  const canViewGatewaySettings = hasScope(c.get('effectiveScopes') || [], 'settings:gateway:view');
  return c.json({
    data: {
      fileUploadMaxBytes: config.fileUploadMaxBytes,
      fileOpenMaxBytes: config.fileOpenMaxBytes,
      gatewayGrpcPublicTarget: canViewGatewaySettings ? config.gatewayGrpcPublicTarget : null,
      gatewayGrpcLocalIp: canViewGatewaySettings ? config.gatewayGrpcLocalIp : null,
      relayAutoRecovery: canViewGatewaySettings ? config.relayAutoRecovery : false,
      ...(canViewGatewaySettings ? { relay: config.relay } : {}),
      features: {
        ...config.features,
        loggingEnabled: loggingFeature.isEnabled(),
      },
    },
  });
});

systemRoutes.post('/relay/recovery', sessionOnly, requireScope('admin:system'), async (c) => {
  const user = c.get('user')!;
  const data = await container.resolve(RelaySupervisorService).retryRecovery(user.id);
  return c.json({ data });
});

systemRoutes.get('/relay', requireScope('settings:gateway:view'), async (c) => {
  const local = container.resolve(RelaySupervisorService).getSnapshot(true);
  const pool = container.isRegistered(RelayPoolService)
    ? await container.resolve(RelayPoolService).getSnapshot()
    : null;
  const data = pool ? { ...local, ...pool, local } : local;
  return c.json({ data });
});

systemRoutes.post('/relay/rebalance', sessionOnly, requireScope('admin:system'), async (c) => {
  const user = c.get('user')!;
  const data = await container.resolve(RelayPoolService).stageRebalance(user.id);
  return c.json({ data }, 202);
});

systemRoutes.post('/relay/instances/:instanceId/drain', sessionOnly, requireScope('admin:system'), async (c) => {
  const user = c.get('user')!;
  const instanceId = z.string().uuid().parse(c.req.param('instanceId'));
  const body = z.object({ confirm: z.literal(true) }).parse(await c.req.json());
  void body;
  await container.resolve(RelayPoolService).drainInstance(instanceId, user.id, true);
  return c.json({ data: await container.resolve(RelayPoolService).getSnapshot() });
});

systemRoutes.post('/relay/instances/:instanceId/resume', sessionOnly, requireScope('admin:system'), async (c) => {
  const user = c.get('user')!;
  const instanceId = z.string().uuid().parse(c.req.param('instanceId'));
  await container.resolve(RelayPoolService).drainInstance(instanceId, user.id, false);
  return c.json({ data: await container.resolve(RelayPoolService).getSnapshot() });
});

systemRoutes.post(
  '/relay/instances/:instanceId/force-disconnect',
  sessionOnly,
  requireScope('admin:system'),
  async (c) => {
    const user = c.get('user')!;
    const instanceId = z.string().uuid().parse(c.req.param('instanceId'));
    const body = z.object({ confirm: z.literal(true) }).parse(await c.req.json());
    void body;
    await container.resolve(RelayPoolService).forceDisconnectInstance(instanceId, user.id);
    return c.json({ data: await container.resolve(RelayPoolService).getSnapshot() });
  }
);

// POST /check-update — manual check against GitLab (admin only)
systemRoutes.openapi({ ...checkSystemUpdateRoute, middleware: sessionOnly }, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const updateService = container.resolve(UpdateService);
  const status = await updateService.checkForUpdates();
  container.resolve(EventBusService).publish('system.update.changed', { updating: false, statusChanged: true });
  return c.json({ data: status });
});

// POST /update — trigger self-update (admin only)
systemRoutes.openapi({ ...performSystemUpdateRoute, middleware: sessionOnly }, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const body = await c.req.json();
  const { version } = z
    .object({
      version: z.string().regex(RELEASE_VERSION_PATTERN, 'Invalid version format'),
    })
    .parse(body);

  const updateService = container.resolve(UpdateService);
  const eventBus = container.resolve(EventBusService);

  // Verify update is actually available and version matches
  const status = await updateService.getCachedStatus();
  if (!status.updateAvailable) {
    return c.json({ code: 'NO_UPDATE', message: 'No update available' }, 400);
  }
  if (version !== status.latestVersion) {
    return c.json({ code: 'VERSION_MISMATCH', message: 'Requested version does not match available update' }, 400);
  }
  const artifact = await updateService.prepareGatewayUpdate(version);

  // Respond immediately, then trigger the update asynchronously.
  // The container will be replaced — the response must be sent first.
  eventBus.publish('system.update.changed', {
    updating: true,
    component: 'gateway',
    targetVersion: version,
  });
  setTimeout(() => {
    updateService.performUpdate(version, artifact).catch((err) => {
      eventBus.publish('system.update.changed', { updating: false, component: 'gateway', targetVersion: version });
      logger.error('Update failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    });
  }, 500);

  return c.json({ data: { status: 'updating', targetVersion: version } });
});

systemRoutes.openapi({ ...performRelayUpdateRoute, middleware: sessionOnly }, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const { version } = z
    .object({ version: z.string().regex(RELEASE_VERSION_PATTERN, 'Invalid version format') })
    .parse(await c.req.json());
  const updateService = container.resolve(UpdateService);
  const eventBus = container.resolve(EventBusService);
  const status = await updateService.getCachedStatus();
  if (!status.relay.updateAvailable || !status.relay.latestVersion) {
    return c.json({ code: 'NO_UPDATE', message: 'No relay update available' }, 400);
  }
  if (version !== status.relay.latestVersion) {
    return c.json(
      { code: 'VERSION_MISMATCH', message: 'Requested version does not match available relay update' },
      400
    );
  }
  const artifact = await updateService.prepareRelayUpdate(version);
  const userId = c.get('user')!.id;
  updateService.startRelayUpdate(version);
  eventBus.publish('system.update.changed', { updating: true, component: 'relay', targetVersion: version });
  setTimeout(() => {
    updateService
      .performRelayUpdate(version, artifact, userId)
      .then(() => updateService.completeRelayUpdate())
      .then(() => updateService.checkForUpdates())
      .then(() => {
        eventBus.publish('system.update.changed', { updating: false, component: 'relay', targetVersion: version });
      })
      .catch((err) => {
        updateService.failRelayUpdate(err);
        eventBus.publish('system.update.changed', { updating: false, component: 'relay', targetVersion: version });
        logger.error('Relay update failed', {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      });
  }, 500);
  return c.json({ data: { status: 'updating', targetVersion: version } });
});

// GET /release-notes/:version — fetch release notes for a specific version
systemRoutes.openapi({ ...releaseNotesForVersionRoute, middleware: requireScope('admin:update') }, async (c) => {
  const version = c.req.param('version')!;
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    return c.json({ code: 'INVALID_VERSION', message: 'Invalid version format' }, 400);
  }
  const updateService = container.resolve(UpdateService);
  try {
    const notes = await updateService.getReleaseNotes(version);
    return c.json({ data: { version, notes } });
  } catch {
    return c.json({ code: 'FETCH_FAILED', message: `Failed to fetch release notes for ${version}` }, 502);
  }
});

// GET /release-notes — fetch release notes for all versions between current and latest
systemRoutes.openapi({ ...releaseNotesRoute, middleware: requireScope('admin:update') }, async (c) => {
  const updateService = container.resolve(UpdateService);
  const status = await updateService.getCachedStatus();
  if (!status.latestVersion || !status.updateAvailable) {
    return c.json({ data: [] });
  }
  try {
    const notes = await updateService.getReleaseNotesSince(status.currentVersion, status.latestVersion);
    return c.json({ data: notes });
  } catch {
    // Fallback to cached latest release notes
    return c.json({ data: status.releaseNotes ? [{ version: status.latestVersion, notes: status.releaseNotes }] : [] });
  }
});

// ── Daemon Updates ──────────────────────────────────────────────────

// GET /daemon-updates — list update status for all daemon types
systemRoutes.openapi({ ...daemonUpdatesRoute, middleware: requireScope('admin:update') }, async (c) => {
  const service = container.resolve(DaemonUpdateService);
  const data = await service.getCachedStatus();
  return c.json({ data });
});

// POST /daemon-updates/check — force re-check daemon updates
systemRoutes.openapi({ ...checkDaemonUpdatesRoute, middleware: sessionOnly }, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const service = container.resolve(DaemonUpdateService);
  const data = await service.checkForUpdates();
  return c.json({ data });
});

// POST /daemon-updates/:nodeId — trigger update for a specific node
systemRoutes.openapi({ ...updateDaemonRoute, middleware: sessionOnly }, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const nodeId = c.req.param('nodeId')!;
  const service = container.resolve(DaemonUpdateService);
  const { NodeDispatchService } = await import('@/services/node-dispatch.service.js');
  const dispatch = container.resolve(NodeDispatchService);
  const { TOKENS } = await import('@/container.js');
  const { nodes: nodesTable } = await import('@/db/schema/nodes.js');
  const { eq } = await import('drizzle-orm');
  const db = container.resolve<any>(TOKENS.DrizzleClient);

  const [node] = await db.select().from(nodesTable).where(eq(nodesTable.id, nodeId)).limit(1);
  if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');

  const daemonType = daemonTypeForNodeType(node.type);
  if (!daemonType) throw new AppError(400, 'UNSUPPORTED_NODE_TYPE', 'This node does not run an updatable daemon');
  const release = await service.getLatestRelease(daemonType);
  if (!release) throw new AppError(404, 'RELEASE_NOT_FOUND', 'No release found for this daemon type');

  const arch = (((node.capabilities ?? {}) as Record<string, unknown>).architecture as string) ?? 'amd64';
  const artifact = await service.prepareTrustedDaemonUpdate(daemonType, release.tagName, release.version, arch);

  if (daemonType === 'relay') {
    await dispatch.prepareRelaySupervisorRollbackBootstrap(nodeId);
  }
  await service.markNodeUpdateInProgress(nodeId, release.version);
  try {
    const command = await dispatch.sendUpdateDaemonCommand(
      nodeId,
      artifact.downloadUrl,
      release.version,
      artifact.checksum,
      artifact.signedManifest
    );
    service.trackNodeUpdateCompletion(nodeId, command.result);
    await command.accepted;
  } catch (error) {
    await service.clearNodeUpdateInProgress(nodeId);
    throw error;
  }

  return c.json({ data: { scheduled: true, targetVersion: release.version } });
});
