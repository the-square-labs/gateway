import { createHash } from 'node:crypto';
import { getResourceScopedIds, hasScope, hasScopeBase } from '@/lib/permissions.js';
import type { AIProviderRuntimeService } from '@/modules/ai/ai-provider-runtime.service.js';
import { dockerScopedNodeIds } from '@/modules/docker/docker-access-resource.service.js';
import type { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { NodesService } from '@/modules/nodes/nodes.service.js';
import {
  DEFAULT_GENERAL_SETTINGS,
  type GeneralSettings,
  type GeneralSettingsService,
} from '@/modules/settings/general-settings.service.js';
import type { StatusPageConfig, StatusPageService } from '@/modules/status-page/status-page.service.js';
import type { ReadModelCoordinator } from '@/services/read-model-coordinator.service.js';
import type {
  ResourceSnapshotEnvelope,
  ResourceSnapshotLease,
  ResourceSnapshotStore,
} from '@/services/resource-snapshot.store.js';
import type { UpdateService } from '@/services/update.service.js';
import type { User } from '@/types.js';

const NODE_SNAPSHOT_KIND = 'ui-shell-nodes';
const NODE_SNAPSHOT_ID = 'all';
const CONFIG_SNAPSHOT_KIND = 'ui-shell-config';
const CONFIG_SNAPSHOT_ID = 'global';
const STATUS_PAGE_SNAPSHOT_KIND = 'ui-shell-status-page';
const STATUS_PAGE_SNAPSHOT_ID = 'global';
const CLOUDFLARE_SNAPSHOT_KIND = 'ui-shell-cloudflare';
const CLOUDFLARE_SNAPSHOT_ID = 'global';
const DOCKER_VIEW_SCOPES = [
  'docker:containers:view',
  'docker:images:view',
  'docker:volumes:view',
  'docker:networks:view',
] as const;

type ShellNode = Awaited<ReturnType<NodesService['list']>>['data'][number];

export interface UIBootstrapShell {
  access: {
    fingerprint: string;
    scopes: string[];
  };
  systemConfig: {
    fileUploadMaxBytes: number;
    fileOpenMaxBytes: number;
    gatewayPublicIps: string[];
    gatewayGrpcPublicTarget: string | null;
    gatewayGrpcLocalIp: string | null;
    features: {
      pkiEnabled: boolean;
      domainsEnabled: boolean;
      loggingEnabled: boolean;
      inferenceEnabled: boolean;
    };
  };
  navigation: {
    hasNginxNodes: boolean;
    hasCloudflareIntegration: boolean;
    statusPageEnabled: boolean;
    dockerNodes: ShellNode[];
    nodes: ResourceSnapshotEnvelope<ShellNode[]>;
  };
  update: unknown | null;
  aiStatus: unknown | null;
}

/**
 * The authenticated UI's first request. It contains only permission-filtered
 * shell data, so layout decisions are stable before page-area data arrives.
 */
export class UIBootstrapService {
  constructor(
    private readonly snapshots: ResourceSnapshotStore,
    private readonly coordinator: ReadModelCoordinator,
    private readonly nodes: NodesService,
    private readonly settings: GeneralSettingsService,
    private readonly loggingFeature: LoggingFeatureService,
    private readonly integrations: IntegrationsService,
    private readonly statusPage: StatusPageService,
    private readonly updates: UpdateService,
    private readonly aiRuntime: AIProviderRuntimeService
  ) {
    this.coordinator.register({
      id: 'ui-shell:nodes',
      refresh: () => this.refreshNodes(),
      events: [{ channel: 'node.changed' }, { channel: 'node.slug.changed' }],
      fallbackIntervalMs: 10_000,
    });
    this.coordinator.register({
      id: 'ui-shell:config',
      refresh: () => this.refreshConfig(),
      events: [{ channel: 'system.config.changed' }],
      fallbackIntervalMs: 10_000,
    });
    this.coordinator.register({
      id: 'ui-shell:status-page',
      refresh: () => this.refreshStatusPageConfig(),
      events: [{ channel: 'status-page.changed' }],
      fallbackIntervalMs: 10_000,
    });
    this.coordinator.register({
      id: 'ui-shell:cloudflare',
      refresh: () => this.refreshCloudflareIntegration(),
      events: [{ channel: 'integration.connector.changed' }],
      fallbackIntervalMs: 10_000,
    });
  }

  async getShell(user: User, scopes: string[]): Promise<UIBootstrapShell> {
    const [nodeSnapshot, configSnapshot, statusPageSnapshot, cloudflareSnapshot, update, aiStatus] = await Promise.all([
      this.getNodeSnapshot(),
      this.getConfigSnapshot(),
      this.getStatusPageConfigSnapshot(),
      this.getCloudflareIntegrationSnapshot(),
      hasScope(scopes, 'admin:update') ? this.updates.getCachedStatus() : Promise.resolve(null),
      hasScope(scopes, 'feat:ai:use') ? this.aiRuntime.statusForUser(user) : Promise.resolve(null),
    ]);
    const config = configSnapshot.data;

    const visibleNodes = this.visibleNodes(nodeSnapshot.data, scopes);
    const dockerNodes = this.visibleDockerNodes(nodeSnapshot.data, scopes);

    return {
      access: {
        fingerprint: createHash('sha256')
          .update(`${user.id}\u0000${[...scopes].sort().join('\u0000')}`)
          .digest('base64url'),
        scopes: [...scopes],
      },
      systemConfig: {
        fileUploadMaxBytes: config.fileUploadMaxBytes,
        fileOpenMaxBytes: config.fileOpenMaxBytes,
        gatewayPublicIps: config.gatewayPublicIps,
        gatewayGrpcPublicTarget: config.gatewayGrpcPublicTarget,
        gatewayGrpcLocalIp: config.gatewayGrpcLocalIp,
        features: {
          pkiEnabled: config.features.pkiEnabled,
          domainsEnabled: config.features.domainsEnabled,
          loggingEnabled: this.loggingFeature.isEnabled(),
          inferenceEnabled: config.features.inferenceEnabled,
        },
      },
      navigation: {
        // Navigation is permission-driven, not data-driven. Keeping the
        // section present avoids a late layout shift while node snapshots are
        // warming; an empty resource page owns its own empty state.
        hasNginxNodes: true,
        hasCloudflareIntegration: cloudflareSnapshot.data,
        statusPageEnabled: hasScope(scopes, 'status-page:view') && statusPageSnapshot.data.enabled,
        dockerNodes,
        nodes: { ...nodeSnapshot, data: visibleNodes },
      },
      update,
      aiStatus,
    };
  }

  private async getNodeSnapshot(): Promise<ResourceSnapshotEnvelope<ShellNode[]>> {
    const cached = await this.snapshots.get<ShellNode[]>(NODE_SNAPSHOT_KIND, NODE_SNAPSHOT_ID);
    if (cached) return cached;

    const refreshed = await this.snapshots.withLease(NODE_SNAPSHOT_KIND, NODE_SNAPSHOT_ID, (lease) => this.loadNodes(lease));
    if (refreshed.acquired) return refreshed.value;

    // Another request is already rebuilding the safe DB-derived source. Do
    // not block the shell or issue a live daemon request; keep routes visible
    // until the snapshot arrives on the next lightweight refresh.
    this.coordinator.enqueue('ui-shell:nodes');
    return {
      data: [],
      revision: 0,
      observedAt: null,
      lastAttemptAt: new Date().toISOString(),
      lastError: null,
      refreshStatus: 'refreshing',
      availability: 'unknown',
    };
  }

  private async refreshNodes(): Promise<void> {
    const leased = await this.snapshots.withLease(NODE_SNAPSHOT_KIND, NODE_SNAPSHOT_ID, (lease) => this.loadNodes(lease));
    if (!leased.acquired) return;
  }

  private async getConfigSnapshot(): Promise<ResourceSnapshotEnvelope<GeneralSettings>> {
    const cached = await this.snapshots.get<GeneralSettings>(CONFIG_SNAPSHOT_KIND, CONFIG_SNAPSHOT_ID);
    if (cached) return cached;

    const refreshed = await this.snapshots.withLease(CONFIG_SNAPSHOT_KIND, CONFIG_SNAPSHOT_ID, (lease) => this.loadConfig(lease));
    if (refreshed.acquired) return refreshed.value;

    // A peer is already doing the safe database read. The request still needs
    // the feature contract before it renders navigation, so fall back only to
    // the safe database source rather than inventing a permissive default.
    return this.loadConfig();
  }

  private async refreshConfig(): Promise<void> {
    const leased = await this.snapshots.withLease(CONFIG_SNAPSHOT_KIND, CONFIG_SNAPSHOT_ID, (lease) => this.loadConfig(lease));
    if (!leased.acquired) return;
  }

  private async getStatusPageConfigSnapshot(): Promise<ResourceSnapshotEnvelope<StatusPageConfig>> {
    const cached = await this.snapshots.get<StatusPageConfig>(STATUS_PAGE_SNAPSHOT_KIND, STATUS_PAGE_SNAPSHOT_ID);
    if (cached) return cached;

    const refreshed = await this.snapshots.withLease(STATUS_PAGE_SNAPSHOT_KIND, STATUS_PAGE_SNAPSHOT_ID, (lease) =>
      this.loadStatusPageConfig(lease)
    );
    if (refreshed.acquired) return refreshed.value;

    // The UI needs a stable navigation decision now. This remains a safe DB
    // read and never reaches a managed resource or node daemon.
    return this.loadStatusPageConfig();
  }

  private async refreshStatusPageConfig(): Promise<void> {
    const leased = await this.snapshots.withLease(STATUS_PAGE_SNAPSHOT_KIND, STATUS_PAGE_SNAPSHOT_ID, (lease) =>
      this.loadStatusPageConfig(lease)
    );
    if (!leased.acquired) return;
  }

  private async getCloudflareIntegrationSnapshot(): Promise<ResourceSnapshotEnvelope<boolean>> {
    const cached = await this.snapshots.get<boolean>(CLOUDFLARE_SNAPSHOT_KIND, CLOUDFLARE_SNAPSHOT_ID);
    if (cached) return cached;

    const refreshed = await this.snapshots.withLease(CLOUDFLARE_SNAPSHOT_KIND, CLOUDFLARE_SNAPSHOT_ID, (lease) =>
      this.loadCloudflareIntegration(lease)
    );
    if (refreshed.acquired) return refreshed.value;

    // This is a local persisted-settings lookup, never a request to Cloudflare.
    return this.loadCloudflareIntegration();
  }

  private async refreshCloudflareIntegration(): Promise<void> {
    const leased = await this.snapshots.withLease(CLOUDFLARE_SNAPSHOT_KIND, CLOUDFLARE_SNAPSHOT_ID, (lease) =>
      this.loadCloudflareIntegration(lease)
    );
    if (!leased.acquired) return;
  }

  private async loadNodes(lease?: ResourceSnapshotLease | null): Promise<ResourceSnapshotEnvelope<ShellNode[]>> {
    await this.snapshots.markRefreshing(NODE_SNAPSHOT_KIND, NODE_SNAPSHOT_ID, [], 'unknown', lease);
    try {
      const nodes: ShellNode[] = [];
      for (let page = 1; ; page += 1) {
        const response = await this.nodes.list({ page, limit: 1_000 });
        nodes.push(...response.data);
        if (page >= (response.totalPages ?? page)) break;
      }
      return await this.snapshots.replace(NODE_SNAPSHOT_KIND, NODE_SNAPSHOT_ID, nodes, {
        availability: 'available', lease,
      });
    } catch (error) {
      return this.snapshots.markError(NODE_SNAPSHOT_KIND, NODE_SNAPSHOT_ID, [], error, 'unknown', lease);
    }
  }

  private async loadConfig(lease?: ResourceSnapshotLease | null): Promise<ResourceSnapshotEnvelope<GeneralSettings>> {
    await this.snapshots.markRefreshing(CONFIG_SNAPSHOT_KIND, CONFIG_SNAPSHOT_ID, DEFAULT_GENERAL_SETTINGS, 'unknown', lease);
    try {
      const config = await this.settings.getConfig();
      return await this.snapshots.replace(CONFIG_SNAPSHOT_KIND, CONFIG_SNAPSHOT_ID, config, {
        availability: 'available', lease,
      });
    } catch (error) {
      return this.snapshots.markError(
        CONFIG_SNAPSHOT_KIND,
        CONFIG_SNAPSHOT_ID,
        DEFAULT_GENERAL_SETTINGS,
        error,
        'unknown',
        lease
      );
    }
  }

  private async loadStatusPageConfig(lease?: ResourceSnapshotLease | null): Promise<ResourceSnapshotEnvelope<StatusPageConfig>> {
    const fallback = { enabled: false } as StatusPageConfig;
    await this.snapshots.markRefreshing(STATUS_PAGE_SNAPSHOT_KIND, STATUS_PAGE_SNAPSHOT_ID, fallback, 'unknown', lease);
    try {
      const config = await this.statusPage.getConfig();
      return await this.snapshots.replace(STATUS_PAGE_SNAPSHOT_KIND, STATUS_PAGE_SNAPSHOT_ID, config, {
        availability: 'available', lease,
      });
    } catch (error) {
      return this.snapshots.markError(STATUS_PAGE_SNAPSHOT_KIND, STATUS_PAGE_SNAPSHOT_ID, fallback, error, 'unknown', lease);
    }
  }

  private async loadCloudflareIntegration(lease?: ResourceSnapshotLease | null): Promise<ResourceSnapshotEnvelope<boolean>> {
    await this.snapshots.markRefreshing(CLOUDFLARE_SNAPSHOT_KIND, CLOUDFLARE_SNAPSHOT_ID, false, 'unknown', lease);
    try {
      const hasIntegration = await this.integrations.hasEnabledCloudflareConnector();
      return await this.snapshots.replace(
        CLOUDFLARE_SNAPSHOT_KIND,
        CLOUDFLARE_SNAPSHOT_ID,
        hasIntegration,
        { availability: 'available', lease }
      );
    } catch (error) {
      return this.snapshots.markError(
        CLOUDFLARE_SNAPSHOT_KIND,
        CLOUDFLARE_SNAPSHOT_ID,
        false,
        error,
        'unknown',
        lease
      );
    }
  }

  private visibleNodes(nodes: ShellNode[], scopes: string[]): ShellNode[] {
    if (hasScope(scopes, 'nodes:details') || hasScope(scopes, 'nodes:folders:manage')) return nodes;
    const allowed = new Set(getResourceScopedIds(scopes, 'nodes:details'));
    return allowed.size > 0 || hasScopeBase(scopes, 'nodes:details')
      ? nodes.filter((node) => allowed.has(String(node.id)))
      : [];
  }

  private visibleDockerNodes(nodes: ShellNode[], scopes: string[]): ShellNode[] {
    const broadDockerAccess = DOCKER_VIEW_SCOPES.some((scope) => hasScope(scopes, scope));
    const allowedNodeIds = new Set(dockerScopedNodeIds(scopes, DOCKER_VIEW_SCOPES));
    if (!broadDockerAccess && allowedNodeIds.size === 0) return [];
    return nodes.filter(
      (node) =>
        node.type === 'docker' &&
        node.status === 'online' &&
        node.isConnected &&
        !(node.capabilities as Record<string, unknown> | undefined)?.versionMismatch &&
        (broadDockerAccess || allowedNodeIds.has(String(node.id)))
    );
  }
}
