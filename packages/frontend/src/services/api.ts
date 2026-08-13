import {
  INFERENCE_SELF_USAGE_CACHE_KEY,
  publishInferenceSelfUsage,
} from "@/lib/inference-self-usage";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import type {
  AccessList,
  Alert,
  ApiToken,
  AuditLogEntry,
  AuthProvisioningSettings,
  BrowserSession,
  CreateAccessListRequest,
  CreateDomainRequest,
  DashboardBootstrap,
  DashboardBootstrapRequest,
  DashboardStats,
  DeleteDomainRequest,
  DnsStatus,
  Domain,
  DomainSearchResult,
  DomainWithUsage,
  FinalizeSetupState,
  FinalizeSetupStep,
  FinalizeSetupStepStatus,
  LinkInternalCertRequest,
  NginxTemplate,
  PaginatedResponse,
  PermissionGroup,
  ProxyHost,
  ProxyHostFolder,
  PublicStatusPageDto,
  RequestACMECertRequest,
  ResourceSearchResponse,
  SSLCertificate,
  SSLCertificateOperationResult,
  SSLCertStatus,
  SSLCertType,
  StatusPageConfig,
  StatusPageIncident,
  StatusPageIncidentUpdate,
  StatusPageIncidentUpdateStatus,
  StatusPageProxyTemplateOption,
  StatusPageServiceItem,
  StatusPageSourceType,
  TemplateVariableDef,
  UIBootstrapShell,
  UpdateDomainRequest,
  UploadCertRequest,
  User,
} from "@/types";
import type {
  AIContextEstimate,
  AIMessage,
  AIMessageAttachment,
  AIPlanStatus,
  AIRunStatus,
  AISandboxArtifact,
  AISandboxJob,
  AISandboxOutput,
  AISandboxStatus,
  PageContext,
} from "@/types/ai";
import type { FileEntry } from "@/types/docker";
import { withAuthApi } from "./api-auth";
import { API_BASE, ApiClientBase } from "./api-base";
import { withDatabaseApi } from "./api-databases";
import { withDockerApi } from "./api-docker";
import { withInferenceApi } from "./api-inference";
import { withIntegrationsApi } from "./api-integrations";
import { withLoggingApi } from "./api-logging";
import { withNotificationApi } from "./api-notifications";
import { withPkiApi } from "./api-pki";
import { withProxyApi } from "./api-proxy";
import { withSystemApi } from "./api-system";
import { type BackgroundPrewarmTask, runBackgroundPrewarm } from "./background-prewarm";

class ApiClient extends withInferenceApi(
  withIntegrationsApi(
    withLoggingApi(
      withNotificationApi(
        withAuthApi(
          withSystemApi(withDockerApi(withDatabaseApi(withPkiApi(withProxyApi(ApiClientBase)))))
        )
      )
    )
  )
) {
  private prewarmTail: Promise<void> = Promise.resolve();

  async getUIBootstrap(): Promise<UIBootstrapShell> {
    return this.unwrapData(this.request<{ data: UIBootstrapShell }>("/ui/bootstrap"));
  }

  async getFinalizeSetupState(): Promise<FinalizeSetupState | null> {
    return this.unwrapData(this.request<{ data: FinalizeSetupState | null }>("/finalize-setup"));
  }

  async updateFinalizeSetupStep(
    step: FinalizeSetupStep,
    status: Exclude<FinalizeSetupStepStatus, "pending">
  ): Promise<FinalizeSetupState> {
    return this.unwrapData(
      this.request<{ data: FinalizeSetupState }>(`/finalize-setup/steps/${step}`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      })
    );
  }

  async getFinalizeSetupMfaReminder(): Promise<boolean> {
    const result = await this.unwrapData(
      this.request<{ data: { show: boolean } }>("/finalize-setup/mfa-reminder")
    );
    return result.show;
  }

  async hideFinalizeSetupMfaReminder(): Promise<void> {
    await this.request("/finalize-setup/mfa-reminder/hide", { method: "POST" });
  }

  /**
   * Warm route-level read models after authentication. Requests are started
   * sequentially by runBackgroundPrewarm so login never becomes an API burst.
   */
  prefetchAll(
    isAdmin: boolean,
    signal: AbortSignal,
    extraTasks: BackgroundPrewarmTask[] = []
  ): Promise<void> {
    const showSystem =
      useUIStore.getState().showSystemCertificates &&
      useAuthStore.getState().hasScope("admin:details:certificates");
    const auth = useAuthStore.getState();
    const tasks: BackgroundPrewarmTask[] = [];
    const add = (condition: boolean, key: string, run: () => Promise<unknown>) => {
      if (condition) tasks.push({ key, run });
    };
    const cache =
      <T>(key: string, request: () => Promise<T>) =>
      () =>
        request().then((data) => {
          this.setCache(key, data);
          return data;
        });

    add(
      true,
      "dashboard:stats",
      cache(`dashboard:stats:${showSystem ? "system" : "default"}`, () =>
        this.getDashboardStats(showSystem)
      )
    );
    add(
      true,
      "dashboard:health",
      cache("dashboard:health", () => this.getHealthOverview())
    );
    add(
      auth.hasAnyScope("pki:ca:view:root", "pki:ca:view:intermediate"),
      "cas",
      cache(`cas:list:${showSystem ? "system" : "default"}`, () => this.listCAs({ showSystem }))
    );
    add(
      auth.hasScopedAccess("proxy:view"),
      "proxy-hosts",
      cache("proxy:grouped", () => this.getGroupedProxyHosts({}))
    );
    add(
      auth.hasScopedAccess("ssl:cert:view"),
      "ssl-certificates",
      cache(`ssl:list:${showSystem ? "system" : "default"}`, () =>
        this.listSSLCertificates({ page: 1, limit: 25, status: "active", showSystem })
      )
    );
    add(
      auth.hasScopedAccess("pki:cert:view"),
      "pki-certificates",
      cache(`certificates:list:${showSystem ? "system" : "default"}`, () =>
        this.listCertificates({ page: 1, limit: 25, status: "active", showSystem })
      )
    );
    add(
      auth.hasScope("domains:view"),
      "domains",
      cache("domains:list:folder-view", () => this.listDomains({ page: 1, limit: 1000 }))
    );
    add(
      auth.hasScope("pki:templates:view"),
      "pki-templates",
      cache("templates:list", () => this.listTemplates())
    );
    add(
      auth.hasScopedAccess("acl:view"),
      "access-lists",
      cache("access-lists:list", () => this.listAccessLists())
    );
    add(
      auth.hasScopedAccess("proxy:templates:view"),
      "nginx-templates",
      cache("nginx-templates:list", () => this.listNginxTemplates())
    );
    add(
      auth.hasScopedAccess("nodes:details"),
      "nodes",
      cache("nodes:list:default", () => this.listNodes({ page: 1, limit: 50 }))
    );
    add(
      auth.hasScopedAccess("databases:view"),
      "databases",
      cache("databases:list", () =>
        this.listDatabases({ limit: 200 }).then((result) => result.data)
      )
    );
    add(
      auth.hasScopedAccess("logs:environments:view"),
      "logging-environments",
      cache("logging:environments", () => this.listLoggingEnvironments())
    );
    add(
      auth.hasScopedAccess("logs:schemas:view"),
      "logging-schemas",
      cache("logging:schemas", () => this.listLoggingSchemas())
    );
    add(
      auth.hasScope("settings:gateway:view"),
      "gateway-settings",
      cache("settings:auth-provisioning", () => this.getAuthProvisioningSettings())
    );
    add(auth.hasScope("settings:gateway:view"), "relay", () => this.getRelayStatus());
    add(
      auth.hasScope("docker:registries:view"),
      "docker-registries",
      cache("settings:docker-registries", () => this.listDockerRegistries())
    );
    add(
      auth.hasScope("housekeeping:view"),
      "housekeeping-config",
      cache("housekeeping:config", () => this.getHousekeepingConfig())
    );
    add(
      auth.hasScope("housekeeping:view"),
      "housekeeping-stats",
      cache("housekeeping:stats", () => this.getHousekeepingStats())
    );
    add(
      auth.hasScope("license:view"),
      "license",
      cache("settings:license-status", () => this.getLicenseStatus())
    );
    add(
      auth.hasScope("status-page:view"),
      "status-page-settings",
      cache("settings:status-page-config", () => this.getStatusPageSettings())
    );
    add(
      auth.hasScope("status-page:view"),
      "status-page-templates",
      cache("settings:status-page-proxy-templates", () => this.listStatusPageProxyTemplates())
    );
    add(
      auth.hasAnyScope("integrations:gitlab:view", "integrations:gitlab:manage"),
      "gitlab-integrations",
      cache("settings:gitlab-connectors", () => this.listGitLabConnectors())
    );
    add(
      auth.hasAnyScope("notifications:alerts:view", "notifications:view", "notifications:manage"),
      "notification-alerts",
      cache("notifications:alerts", () =>
        this.listAlertRules({ limit: 100 }).then((result) => result.data ?? [])
      )
    );
    add(
      auth.hasAnyScope("notifications:webhooks:view", "notifications:view", "notifications:manage"),
      "notification-webhooks",
      cache("notifications:webhooks", () =>
        this.listWebhooks({ limit: 100 }).then((result) => result.data ?? [])
      )
    );
    add(
      auth.hasScope("feat:ai:configure"),
      "ai-settings",
      cache("settings:ai-config", () => this.getAIConfig())
    );
    add(
      auth.hasAnyScope(
        "inference:providers:view",
        "inference:models:manage",
        "inference:limits:manage"
      ),
      "inference-settings",
      () => this.getInferenceSettings()
    );
    add(auth.hasScope("inference:providers:view"), "inference-provider-catalog", () =>
      this.listInferenceProviderCatalog()
    );
    add(auth.hasScope("inference:providers:view"), "inference-provider-connections", () =>
      this.listInferenceProviderConnections()
    );
    add(
      auth.hasScope("admin:update"),
      "version",
      cache("system:version", () => this.getVersionInfo())
    );
    add(
      isAdmin && auth.hasScopedAccess("admin:users"),
      "admin-users",
      cache("admin:users", () => this.listUsers())
    );
    add(
      isAdmin && auth.hasScopedAccess("admin:groups"),
      "admin-groups",
      cache("admin:groups", () => this.listGroups())
    );
    add(
      isAdmin && auth.hasScopedAccess("admin:audit"),
      "audit",
      cache("audit:list", () => this.getAuditLog({ limit: 25 }))
    );

    const run = this.prewarmTail
      .catch(() => {})
      .then(async () => {
        if (signal.aborted) return;
        await runBackgroundPrewarm([...tasks, ...extraTasks], signal);
      });
    // A reconnect reconciliation must never overlap the initial login prewarm.
    // Queue it behind the active run so request starts remain staggered.
    this.prewarmTail = run.catch(() => {});
    return run;
  }

  // ── Audit ─────────────────────────────────────────────────────────

  async getAuditLog(params?: {
    page?: number;
    limit?: number;
    action?: string;
    actions?: string[];
    resourceType?: string;
    resourceTypes?: string[];
    userId?: string;
    userIds?: string[];
    from?: string;
    to?: string;
    excludedActions?: string[];
    excludedResourceTypes?: string[];
  }): Promise<PaginatedResponse<AuditLogEntry>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set("page", params.page.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.action) searchParams.set("action", params.action);
    for (const action of params?.actions ?? []) searchParams.append("action", action);
    if (params?.resourceType) searchParams.set("resourceType", params.resourceType);
    for (const resourceType of params?.resourceTypes ?? []) {
      searchParams.append("resourceType", resourceType);
    }
    if (params?.userId) searchParams.set("userId", params.userId);
    for (const userId of params?.userIds ?? []) searchParams.append("userId", userId);
    if (params?.from) searchParams.set("from", params.from);
    if (params?.to) searchParams.set("to", params.to);
    for (const action of params?.excludedActions ?? [])
      searchParams.append("excludeAction", action);
    for (const resourceType of params?.excludedResourceTypes ?? []) {
      searchParams.append("excludeResourceType", resourceType);
    }

    const query = searchParams.toString();
    return this.request<PaginatedResponse<AuditLogEntry>>(`/audit${query ? `?${query}` : ""}`);
  }

  async getAuditUsers(): Promise<
    Array<{ userId: string | null; userName: string | null; userEmail: string | null }>
  > {
    return this.unwrapData(
      this.request<{
        data: Array<{ userId: string | null; userName: string | null; userEmail: string | null }>;
      }>("/audit/users")
    );
  }

  // ── Alerts ────────────────────────────────────────────────────────

  async getAlerts(): Promise<Alert[]> {
    return this.request<Alert[]>("/alerts");
  }

  async dismissAlert(id: string): Promise<void> {
    return this.request<void>(`/alerts/${id}/dismiss`, { method: "POST" });
  }

  async searchResources(
    query: string,
    options?: { types?: string[]; nodeId?: string; limit?: number }
  ): Promise<ResourceSearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (options?.types?.length) params.set("types", options.types.join(","));
    if (options?.nodeId) params.set("nodeId", options.nodeId);
    if (options?.limit) params.set("limit", String(options.limit));
    return this.unwrapData(
      this.request<{ data: ResourceSearchResponse }>(`/resources/search?${params.toString()}`)
    );
  }

  // ── Tokens ────────────────────────────────────────────────────────

  async listTokens(): Promise<ApiToken[]> {
    return this.request<ApiToken[]>("/tokens");
  }

  async createToken(data: {
    name: string;
    scopes: string[];
  }): Promise<ApiToken & { token: string }> {
    return this.request(`/tokens`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async renameToken(id: string, name: string): Promise<void> {
    return this.updateToken(id, { name });
  }

  async updateToken(id: string, data: { name?: string; scopes?: string[] }): Promise<void> {
    return this.request<void>(`/tokens/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  }

  async revokeToken(id: string): Promise<void> {
    return this.request<void>(`/tokens/${id}`, { method: "DELETE" });
  }

  // ── Admin ─────────────────────────────────────────────────────────

  async listUsers(): Promise<User[]> {
    return this.request<User[]>("/admin/users");
  }

  async createUser(data: {
    email: string;
    name: string;
    groupId: string;
    authMethod?: "oidc" | "password" | "email_otp";
  }): Promise<User> {
    return this.request<User>("/admin/users", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateUserGroup(userId: string, groupId: string): Promise<User> {
    return this.request<User>(`/admin/users/${userId}/group`, {
      method: "PATCH",
      body: JSON.stringify({ groupId }),
    });
  }

  async updateUserAuthMethod(
    userId: string,
    authMethod: "oidc" | "password" | "email_otp"
  ): Promise<User> {
    return this.request<User>(`/admin/users/${userId}/auth-method`, {
      method: "PATCH",
      body: JSON.stringify({ authMethod }),
    });
  }

  async updateUserName(userId: string, name: string): Promise<User> {
    return this.request<User>(`/admin/users/${userId}/name`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  async sendUserPasswordLink(
    userId: string
  ): Promise<{ message: string; purpose: "password_setup" | "password_reset" }> {
    return this.request(`/admin/users/${userId}/password-setup`, { method: "POST" });
  }

  async listAdminUserSessions(userId: string): Promise<BrowserSession[]> {
    return this.request<BrowserSession[]>(`/admin/users/${userId}/sessions`);
  }

  async impersonateUser(userId: string): Promise<void> {
    await this.request(`/admin/users/${userId}/impersonate`, { method: "POST" });
  }

  async revokeAdminUserSession(userId: string, sessionId: string): Promise<void> {
    await this.request(`/admin/users/${userId}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }

  async revokeAllAdminUserSessions(userId: string): Promise<void> {
    await this.request(`/admin/users/${userId}/sessions`, { method: "DELETE" });
  }

  async resetAdminUserMfa(userId: string): Promise<void> {
    await this.request(`/admin/users/${userId}/mfa/reset`, { method: "POST" });
  }

  async updateUserAdditionalPermissions(userId: string, additionalScopes: string[]): Promise<User> {
    return this.request<User>(`/admin/users/${userId}/additional-permissions`, {
      method: "PUT",
      body: JSON.stringify({ additionalScopes }),
    });
  }

  async blockUser(userId: string, blocked: boolean): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/admin/users/${userId}/block`, {
      method: "PATCH",
      body: JSON.stringify({ blocked }),
    });
  }

  async deleteUser(userId: string): Promise<void> {
    await this.request(`/admin/users/${userId}`, { method: "DELETE" });
  }

  async listDeletedUsers(): Promise<import("@/types").DeletedUser[]> {
    return this.request<import("@/types").DeletedUser[]>("/admin/users/deleted");
  }

  async restoreUser(userId: string, groupId?: string): Promise<User> {
    return this.request<User>(`/admin/users/${userId}/restore`, {
      method: "POST",
      body: JSON.stringify(groupId ? { groupId } : {}),
    });
  }

  async listAdminUserFolders(): Promise<import("@/types").ResourceFolderTreeNode[]> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolderTreeNode[] }>("/admin/user-folders")
    );
  }

  async createAdminUserFolder(data: {
    name: string;
    parentId?: string;
  }): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>("/admin/user-folders", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateAdminUserFolder(
    id: string,
    data: { name: string }
  ): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>(`/admin/user-folders/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async deleteAdminUserFolder(id: string): Promise<void> {
    await this.request(`/admin/user-folders/${id}`, { method: "DELETE" });
  }

  async reorderAdminUserFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/admin/user-folders/reorder", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  async moveAdminUsersToFolder(ids: string[], folderId: string | null): Promise<void> {
    await this.request("/admin/user-folders/move-users", {
      method: "POST",
      body: JSON.stringify({ ids, folderId }),
    });
  }

  async reorderAdminUsers(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/admin/user-folders/reorder-users", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  async getAuthProvisioningSettings(): Promise<AuthProvisioningSettings> {
    return this.request<AuthProvisioningSettings>("/admin/auth-settings");
  }

  async updateAuthProvisioningSettings(data: {
    oidcAutoCreateUsers?: boolean;
    oidcDefaultGroupId?: string;
    oidcRequireVerifiedEmail?: boolean;
    oauthExtendedCallbackCompatibility?: boolean;
    mfaExistingSessionGracePeriodDays?: number;
    methods?: Partial<NonNullable<AuthProvisioningSettings["methods"]>>;
    passwordPolicy?: Partial<NonNullable<AuthProvisioningSettings["passwordPolicy"]>>;
    smtp?: {
      host: string;
      port: number;
      tlsMode: "starttls" | "tls";
      username: string;
      password?: string;
      senderName: string;
      senderEmail: string;
      testRecipient?: string;
      testEmailKind?: "smtp_configuration" | "password_setup" | "password_reset" | "email_otp";
    };
    oidc?: {
      issuer: string;
      clientId: string;
      clientSecret?: string;
      redirectUri: string;
      scopes?: string;
    };
    logging?: {
      mode: "disabled" | "local" | "external";
      url?: string;
      username?: string;
      password?: string;
      database?: string;
      table?: string;
      requestTimeoutMs?: number;
    };
    mcpServerEnabled?: boolean;
    mcpExtendedCompatibility?: boolean;
    webTlsEnabled?: boolean;
    generalSettings?: Partial<AuthProvisioningSettings["generalSettings"]>;
    networkSecurity?: Partial<AuthProvisioningSettings["networkSecurity"]>;
    outboundWebhookPolicy?: Partial<AuthProvisioningSettings["outboundWebhookPolicy"]>;
  }): Promise<AuthProvisioningSettings> {
    return this.request<AuthProvisioningSettings>("/admin/auth-settings", {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  // ── Permission Groups ──

  async listGroups(): Promise<PermissionGroup[]> {
    return this.request<PermissionGroup[]>("/admin/groups");
  }

  async getGroup(id: string): Promise<PermissionGroup> {
    return this.request<PermissionGroup>(`/admin/groups/${id}`);
  }

  async createGroup(data: {
    name: string;
    description?: string;
    scopes: string[];
    parentId?: string | null;
    requireGateway2fa?: boolean;
  }): Promise<PermissionGroup> {
    return this.request<PermissionGroup>("/admin/groups", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateGroup(
    id: string,
    data: {
      name?: string;
      description?: string | null;
      scopes?: string[];
      parentId?: string | null;
      requireGateway2fa?: boolean;
    }
  ): Promise<PermissionGroup> {
    return this.request<PermissionGroup>(`/admin/groups/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteGroup(id: string): Promise<void> {
    await this.request(`/admin/groups/${id}`, { method: "DELETE" });
  }

  async listAdminGroupFolders(): Promise<import("@/types").ResourceFolderTreeNode[]> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolderTreeNode[] }>("/admin/groups/folders")
    );
  }

  async createAdminGroupFolder(data: {
    name: string;
    parentId?: string;
  }): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>("/admin/groups/folders", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateAdminGroupFolder(
    id: string,
    data: { name: string }
  ): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>(`/admin/groups/folders/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async deleteAdminGroupFolder(id: string): Promise<void> {
    await this.request(`/admin/groups/folders/${id}`, { method: "DELETE" });
  }

  async reorderAdminGroupFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/admin/groups/folders/reorder", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  async moveAdminGroupsToFolder(ids: string[], folderId: string | null): Promise<void> {
    await this.request("/admin/groups/folders/move-groups", {
      method: "POST",
      body: JSON.stringify({ ids, folderId }),
    });
  }

  async reorderAdminGroups(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/admin/groups/folders/reorder-groups", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  // ── Nodes ──

  async listNodes(params?: {
    search?: string;
    type?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    data: import("@/types").Node[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const query = new URLSearchParams();
    if (params?.search) query.set("search", params.search);
    if (params?.type) query.set("type", params.type);
    if (params?.status) query.set("status", params.status);
    if (params?.page) query.set("page", String(params.page));
    if (params?.limit) query.set("limit", String(params.limit));
    const qs = query.toString();
    return this.request(`/nodes${qs ? `?${qs}` : ""}`);
  }

  async getNode(id: string): Promise<import("@/types").NodeDetail> {
    return this.unwrapData(this.request(`/nodes/${id}`));
  }

  async getNodeBySlug(slug: string): Promise<import("@/types").NodeDetail> {
    return this.unwrapData(this.requestRouteContext(`/nodes/by-slug/${encodeURIComponent(slug)}`));
  }

  async getNodeHealthHistory(id: string): Promise<Array<{ ts: string; status: string }>> {
    return this.unwrapData(this.request(`/nodes/${id}/health-history`));
  }

  async createNode(data: {
    type?: string;
    hostname: string;
    displayName?: string;
  }): Promise<import("@/types").CreateNodeResponse> {
    return this.unwrapData(
      this.request("/nodes", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateNode(
    id: string,
    data: {
      displayName?: string | null;
      appearanceColor?: import("@/types").NodeAppearanceColor | null;
      serviceAddress?: string | null;
    }
  ): Promise<import("@/types").Node> {
    return this.unwrapData(
      this.request(`/nodes/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      })
    );
  }

  async setNodeServiceCreationLock(
    id: string,
    serviceCreationLocked: boolean
  ): Promise<import("@/types").NodeDetail> {
    return this.unwrapData(
      this.request(`/nodes/${id}/service-creation-lock`, {
        method: "PATCH",
        body: JSON.stringify({ serviceCreationLocked }),
      })
    );
  }

  async deleteNode(id: string): Promise<void> {
    await this.request(`/nodes/${id}`, { method: "DELETE" });
  }

  async listNodeFolders(): Promise<import("@/types").ResourceFolderTreeNode[]> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolderTreeNode[] }>("/nodes/folders")
    );
  }

  async createNodeFolder(data: {
    name: string;
    parentId?: string;
  }): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>("/nodes/folders", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateNodeFolder(
    id: string,
    data: { name: string }
  ): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>(`/nodes/folders/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async deleteNodeFolder(id: string): Promise<void> {
    await this.request(`/nodes/folders/${id}`, { method: "DELETE" });
  }

  async reorderNodeFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/nodes/folders/reorder", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  async moveNodesToFolder(ids: string[], folderId: string | null): Promise<void> {
    await this.request("/nodes/folders/move-nodes", {
      method: "POST",
      body: JSON.stringify({ ids, folderId }),
    });
  }

  async reorderNodes(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/nodes/folders/reorder-nodes", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  createNodeMonitoringStream(nodeId: string, options: { focused?: boolean } = {}): EventSource {
    const query = options.focused ? "?focused=true" : "";
    return new EventSource(`${API_BASE}/nodes/${nodeId}/monitoring/stream${query}`, {
      withCredentials: true,
    });
  }

  async getNodeNginxConfig(nodeId: string): Promise<string> {
    const result = await this.unwrapData(
      this.request<{ data: { content: string } }>(`/nodes/${nodeId}/config`)
    );
    return result.content;
  }

  async updateNodeNginxConfig(
    nodeId: string,
    content: string
  ): Promise<{ valid: boolean; error?: string }> {
    return this.unwrapData(
      this.request<{ data: { valid: boolean; error?: string } }>(`/nodes/${nodeId}/config`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      })
    );
  }

  async testNodeNginxConfig(
    nodeId: string,
    content?: string
  ): Promise<{ valid: boolean; error?: string }> {
    return this.unwrapData(
      this.request<{ data: { valid: boolean; error?: string } }>(`/nodes/${nodeId}/config/test`, {
        method: "POST",
        body: content ? JSON.stringify({ content }) : undefined,
      })
    );
  }

  async listNodeDir(nodeId: string, path: string): Promise<FileEntry[]> {
    const response = await this.request<{
      data: FileEntry[];
      total?: number;
      limit?: number;
      truncated?: boolean;
    }>(`/nodes/${nodeId}/files?path=${encodeURIComponent(path)}`);
    const data = response.data;
    if (Array.isArray(data)) {
      Object.defineProperty(data, "_listMeta", {
        value: {
          total: response.total,
          limit: response.limit,
          truncated: response.truncated,
        },
        enumerable: false,
      });
    }
    return data;
  }

  async readNodeFile(nodeId: string, path: string): Promise<ArrayBuffer> {
    return this.requestBinary(`/nodes/${nodeId}/files/read?path=${encodeURIComponent(path)}`);
  }

  async writeNodeFile(nodeId: string, path: string, content: string) {
    const encoded = new TextEncoder().encode(content);
    return this.unwrapData(
      this.uploadRaw<{ data: unknown }>(
        `/nodes/${nodeId}/files/write?path=${encodeURIComponent(path)}`,
        {
          method: "PUT",
          body: encoded,
          headers: { "Content-Type": "application/octet-stream" },
        }
      )
    );
  }

  async createNodeFile(
    nodeId: string,
    path: string,
    content: Blob | BufferSource | string = "",
    onProgress?: (progress: { loaded: number; total: number }) => void
  ) {
    const body =
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : content instanceof Blob
          ? content
          : content;
    return this.uploadRaw<void>(`/nodes/${nodeId}/files/create?path=${encodeURIComponent(path)}`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/octet-stream" },
      onProgress,
    });
  }

  async initNodeFileUpload(
    nodeId: string,
    path: string,
    totalBytes: number
  ): Promise<{ uploadId: string; chunkSize: number }> {
    return this.unwrapData(
      this.request<{ data: { uploadId: string; chunkSize: number } }>(
        `/nodes/${nodeId}/files/uploads`,
        {
          method: "POST",
          body: JSON.stringify({ path, totalBytes }),
        }
      )
    );
  }

  async uploadNodeFileChunk(
    nodeId: string,
    uploadId: string,
    offset: number,
    content: Blob,
    onProgress?: (progress: { loaded: number; total: number }) => void
  ): Promise<{ receivedBytes: number; totalBytes: number }> {
    return this.unwrapData(
      this.uploadRaw<{ data: { receivedBytes: number; totalBytes: number } }>(
        `/nodes/${nodeId}/files/uploads/${uploadId}/chunks?offset=${offset}`,
        {
          method: "PUT",
          body: content,
          headers: { "Content-Type": "application/octet-stream" },
          onProgress,
        }
      )
    );
  }

  async completeNodeFileUpload(
    nodeId: string,
    uploadId: string,
    path: string,
    totalBytes: number
  ): Promise<void> {
    await this.request<void>(`/nodes/${nodeId}/files/uploads/${uploadId}/complete`, {
      method: "POST",
      body: JSON.stringify({ path, totalBytes }),
    });
  }

  async abortNodeFileUpload(nodeId: string, uploadId: string): Promise<void> {
    await this.request<void>(`/nodes/${nodeId}/files/uploads/${uploadId}`, { method: "DELETE" });
  }

  async createNodeDirectory(nodeId: string, path: string) {
    return this.request<void>(`/nodes/${nodeId}/files/directory`, {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  async deleteNodeFile(nodeId: string, path: string) {
    return this.request<void>(`/nodes/${nodeId}/files?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
  }

  async moveNodeFile(nodeId: string, fromPath: string, toPath: string) {
    return this.request<void>(`/nodes/${nodeId}/files/move`, {
      method: "POST",
      body: JSON.stringify({ fromPath, toPath }),
    });
  }

  // ── AI Assistant ──

  async getAIStatus(): Promise<import("@/types/ai").AIProviderStatus> {
    return this.request<import("@/types/ai").AIProviderStatus>("/ai/status");
  }

  async getAIConfig(): Promise<Record<string, unknown>> {
    const res = await this.request<{ data: Record<string, unknown> }>("/ai/config");
    return res.data;
  }

  async updateAIConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.request<{ data: Record<string, unknown> }>("/ai/config", {
      method: "PUT",
      body: JSON.stringify(config),
    });
    return res.data;
  }

  async getAITools(): Promise<
    Record<
      string,
      Array<{
        name: string;
        displayName: string;
        displayDescription: string;
        destructive: boolean;
        requiredScope: string;
      }>
    >
  > {
    const res = await this.request<{
      data: Record<
        string,
        Array<{
          name: string;
          displayName: string;
          displayDescription: string;
          destructive: boolean;
          requiredScope: string;
        }>
      >;
    }>("/ai/tools");
    return res.data;
  }

  async getAIContextEstimate(input?: {
    context?: PageContext;
    conversationId?: string | null;
    model?: string;
    reasoningEffort?: string;
  }): Promise<AIContextEstimate> {
    const res = await this.request<{ data: AIContextEstimate }>("/ai/context-estimate", {
      method: "POST",
      body: JSON.stringify({
        context: input?.context,
        conversationId: input?.conversationId ?? undefined,
        model: input?.model,
        reasoningEffort: input?.reasoningEffort,
      }),
    });
    return res.data;
  }

  async listAIConversations(): Promise<
    Array<{
      id: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      lastUserMessageAt: string | null;
      messageCount: number;
      folderId: string | null;
      status: "active" | "ended" | "context_blocked";
      blockReason: string | null;
      activeRunStatus: AIRunStatus | null;
      planStatus: AIPlanStatus | null;
    }>
  > {
    const res = await this.request<{
      data: Array<{
        id: string;
        title: string;
        createdAt: string;
        updatedAt: string;
        lastUserMessageAt: string | null;
        messageCount: number;
        folderId: string | null;
        status: "active" | "ended" | "context_blocked";
        blockReason: string | null;
        activeRunStatus: AIRunStatus | null;
        planStatus: AIPlanStatus | null;
      }>;
    }>("/ai/conversations");
    return res.data;
  }

  async listAIConversationFolders(): Promise<
    Array<{
      id: string;
      name: string;
      description: string;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
    }>
  > {
    const res = await this.request<{
      data: Array<{
        id: string;
        name: string;
        description: string;
        sortOrder: number;
        createdAt: string;
        updatedAt: string;
      }>;
    }>("/ai/conversation-folders");
    return res.data;
  }

  async createAIConversationFolder(data: { name: string; description?: string }): Promise<{
    id: string;
    name: string;
    description: string;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  }> {
    const res = await this.request<{
      data: {
        id: string;
        name: string;
        description: string;
        sortOrder: number;
        createdAt: string;
        updatedAt: string;
      };
    }>("/ai/conversation-folders", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return res.data;
  }

  async updateAIConversationFolder(
    id: string,
    data: { name?: string; description?: string }
  ): Promise<{
    id: string;
    name: string;
    description: string;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  }> {
    const res = await this.request<{
      data: {
        id: string;
        name: string;
        description: string;
        sortOrder: number;
        createdAt: string;
        updatedAt: string;
      };
    }>(`/ai/conversation-folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    return res.data;
  }

  async deleteAIConversationFolder(id: string): Promise<void> {
    await this.request(`/ai/conversation-folders/${id}`, { method: "DELETE" });
  }

  async reorderAIConversationFolders(items: Array<{ id: string; sortOrder: number }>): Promise<
    Array<{
      id: string;
      name: string;
      description: string;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
    }>
  > {
    const res = await this.request<{
      data: Array<{
        id: string;
        name: string;
        description: string;
        sortOrder: number;
        createdAt: string;
        updatedAt: string;
      }>;
    }>("/ai/conversation-folders/reorder", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
    return res.data;
  }

  async moveAIConversationsToFolder(
    conversationIds: string[],
    folderId: string | null
  ): Promise<{ moved: number }> {
    const res = await this.request<{ data: { moved: number } }>(
      "/ai/conversation-folders/move-conversations",
      {
        method: "PUT",
        body: JSON.stringify({ conversationIds, folderId }),
      }
    );
    return res.data;
  }

  async getAIConversation(id: string): Promise<{
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    lastUserMessageAt: string | null;
    messageCount: number;
    folderId: string | null;
    status: "active" | "ended" | "context_blocked";
    blockReason: string | null;
    activeRunStatus: AIRunStatus | null;
    messages: AIMessage[];
    model: string | null;
    reasoningEffort: string | null;
    lastContext: PageContext | null;
    discoveredToolsets: string[];
    checkpoint: Record<string, unknown> | null;
  }> {
    const res = await this.request<{
      data: {
        id: string;
        title: string;
        createdAt: string;
        updatedAt: string;
        lastUserMessageAt: string | null;
        messageCount: number;
        folderId: string | null;
        status: "active" | "ended" | "context_blocked";
        blockReason: string | null;
        activeRunStatus: AIRunStatus | null;
        messages: AIMessage[];
        model: string | null;
        reasoningEffort: string | null;
        lastContext: PageContext | null;
        discoveredToolsets: string[];
        checkpoint: Record<string, unknown> | null;
      };
    }>(`/ai/conversations/${id}`);
    return res.data;
  }

  async updateAIConversation(
    id: string,
    data: { title: string }
  ): Promise<{
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    lastUserMessageAt: string | null;
    messageCount: number;
    folderId: string | null;
    status: "active" | "ended" | "context_blocked";
    blockReason: string | null;
    activeRunStatus: AIRunStatus | null;
    messages: AIMessage[];
    model: string | null;
    reasoningEffort: string | null;
    lastContext: PageContext | null;
    discoveredToolsets: string[];
    checkpoint: Record<string, unknown> | null;
  }> {
    const res = await this.request<{
      data: {
        id: string;
        title: string;
        createdAt: string;
        updatedAt: string;
        lastUserMessageAt: string | null;
        messageCount: number;
        folderId: string | null;
        status: "active" | "ended" | "context_blocked";
        blockReason: string | null;
        activeRunStatus: AIRunStatus | null;
        messages: AIMessage[];
        model: string | null;
        reasoningEffort: string | null;
        lastContext: PageContext | null;
        discoveredToolsets: string[];
        checkpoint: Record<string, unknown> | null;
      };
    }>(`/ai/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    return res.data;
  }

  async updateAIConversationProvider(
    id: string,
    data: { model: string; reasoningEffort: string | null }
  ): Promise<{
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    lastUserMessageAt: string | null;
    messageCount: number;
    folderId: string | null;
    status: "active" | "ended" | "context_blocked";
    blockReason: string | null;
    activeRunStatus: AIRunStatus | null;
    messages: AIMessage[];
    model: string | null;
    reasoningEffort: string | null;
    lastContext: PageContext | null;
    discoveredToolsets: string[];
    checkpoint: Record<string, unknown> | null;
  }> {
    const res = await this.request<{
      data: {
        id: string;
        title: string;
        createdAt: string;
        updatedAt: string;
        lastUserMessageAt: string | null;
        messageCount: number;
        folderId: string | null;
        status: "active" | "ended" | "context_blocked";
        blockReason: string | null;
        activeRunStatus: AIRunStatus | null;
        messages: AIMessage[];
        model: string | null;
        reasoningEffort: string | null;
        lastContext: PageContext | null;
        discoveredToolsets: string[];
        checkpoint: Record<string, unknown> | null;
      };
    }>(`/ai/conversations/${id}/provider`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    return res.data;
  }

  async deleteAIConversation(id: string): Promise<void> {
    await this.request(`/ai/conversations/${id}`, { method: "DELETE" });
  }

  async rollbackAIConversationToMessage(
    id: string,
    messageId: string,
    activeRunId?: string | null
  ): Promise<{
    message: AIMessage;
    conversation: {
      id: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      lastUserMessageAt: string | null;
      messageCount: number;
      folderId: string | null;
      status: "active" | "ended" | "context_blocked";
      blockReason: string | null;
      activeRunStatus: AIRunStatus | null;
      messages: AIMessage[];
      model: string | null;
      reasoningEffort: string | null;
      lastContext: PageContext | null;
      discoveredToolsets: string[];
      checkpoint: Record<string, unknown> | null;
    };
  }> {
    const res = await this.request<{
      data: {
        message: AIMessage;
        conversation: {
          id: string;
          title: string;
          createdAt: string;
          updatedAt: string;
          lastUserMessageAt: string | null;
          messageCount: number;
          folderId: string | null;
          status: "active" | "ended" | "context_blocked";
          blockReason: string | null;
          activeRunStatus: AIRunStatus | null;
          messages: AIMessage[];
          model: string | null;
          reasoningEffort: string | null;
          lastContext: PageContext | null;
          discoveredToolsets: string[];
          checkpoint: Record<string, unknown> | null;
        };
      };
    }>(`/ai/conversations/${id}/rollback`, {
      method: "POST",
      body: JSON.stringify({
        messageId,
        ...(activeRunId ? { activeRunId } : {}),
      }),
    });
    return res.data;
  }

  async getAISandboxStatus(): Promise<AISandboxStatus> {
    const res = await this.request<{ data: AISandboxStatus }>("/ai/sandbox/status");
    return res.data;
  }

  async listAISandboxJobs(
    options: { activeOnly?: boolean; limit?: number; status?: AISandboxJob["status"] } = {}
  ): Promise<AISandboxJob[]> {
    const params = new URLSearchParams();
    if (options.activeOnly !== undefined) params.set("activeOnly", String(options.activeOnly));
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.status !== undefined) params.set("status", options.status);
    const query = params.toString();
    const res = await this.request<{ data: AISandboxJob[] }>(
      `/ai/sandbox/jobs${query ? `?${query}` : ""}`
    );
    return res.data;
  }

  async killAISandboxJob(id: string): Promise<unknown> {
    const res = await this.request<{ data: unknown }>(`/ai/sandbox/jobs/${id}/kill`, {
      method: "POST",
    });
    return res.data;
  }

  async getAISandboxJobOutput(id: string, tail = 200): Promise<AISandboxOutput> {
    const params = new URLSearchParams({ tail: String(tail) });
    const res = await this.request<{ data: AISandboxOutput }>(
      `/ai/sandbox/jobs/${id}/output?${params}`
    );
    return res.data;
  }

  async listAISandboxArtifacts(): Promise<AISandboxArtifact[]> {
    const res = await this.request<{ data: AISandboxArtifact[] }>("/ai/sandbox/artifacts");
    return res.data;
  }

  async deleteAISandboxArtifact(id: string): Promise<void> {
    await this.request(`/ai/sandbox/artifacts/${id}`, { method: "DELETE" });
  }

  async uploadAIChatArtifact(
    file: File,
    conversationId?: string | null
  ): Promise<AIMessageAttachment> {
    const body = new FormData();
    body.append("file", file);
    if (conversationId) body.append("conversationId", conversationId);
    const res = await this.request<{ data: AIMessageAttachment }>("/ai/sandbox/artifacts", {
      method: "POST",
      body,
    });
    return res.data;
  }

  // ── Status Page ─────────────────────────────────────────────────

  async getStatusPageSettings(): Promise<StatusPageConfig> {
    return this.unwrapData(this.request<{ data: StatusPageConfig }>("/status-page/settings"));
  }

  async updateStatusPageSettings(data: Partial<StatusPageConfig>): Promise<StatusPageConfig> {
    return this.unwrapData(
      this.request<{ data: StatusPageConfig }>("/status-page/settings", {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async listStatusPageProxyTemplates(): Promise<StatusPageProxyTemplateOption[]> {
    return this.unwrapData(
      this.request<{ data: StatusPageProxyTemplateOption[] }>("/status-page/proxy-templates")
    );
  }

  async listStatusPageServices(): Promise<StatusPageServiceItem[]> {
    return this.unwrapData(
      this.request<{ data: StatusPageServiceItem[] }>("/status-page/services")
    );
  }

  async createStatusPageService(data: {
    sourceType: StatusPageSourceType;
    sourceId: string;
    publicName: string;
    publicDescription?: string | null;
    publicGroup?: string | null;
    sortOrder?: number;
    enabled?: boolean;
    createThresholdSeconds?: number;
    resolveThresholdSeconds?: number;
  }): Promise<StatusPageServiceItem> {
    return this.unwrapData(
      this.request<{ data: StatusPageServiceItem }>("/status-page/services", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateStatusPageService(
    id: string,
    data: Partial<Omit<StatusPageServiceItem, "id" | "sourceType" | "sourceId">>
  ): Promise<StatusPageServiceItem> {
    return this.unwrapData(
      this.request<{ data: StatusPageServiceItem }>(`/status-page/services/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async deleteStatusPageService(id: string): Promise<void> {
    await this.request<void>(`/status-page/services/${id}`, { method: "DELETE" });
  }

  async listStatusPageIncidents(params?: {
    status?: "active" | "resolved" | "all";
    limit?: number;
  }): Promise<StatusPageIncident[]> {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set("status", params.status);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const query = searchParams.toString();
    return this.unwrapData(
      this.request<{ data: StatusPageIncident[] }>(
        `/status-page/incidents${query ? `?${query}` : ""}`
      )
    );
  }

  async createStatusPageIncident(data: {
    title: string;
    message: string;
    severity: "info" | "warning" | "critical";
    affectedServiceIds: string[];
  }): Promise<StatusPageIncident> {
    return this.unwrapData(
      this.request<{ data: StatusPageIncident }>("/status-page/incidents", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateStatusPageIncident(
    id: string,
    data: Partial<
      Pick<
        StatusPageIncident,
        "title" | "message" | "severity" | "affectedServiceIds" | "status" | "autoManaged"
      >
    >
  ): Promise<StatusPageIncident> {
    return this.unwrapData(
      this.request<{ data: StatusPageIncident }>(`/status-page/incidents/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async deleteStatusPageIncident(id: string): Promise<void> {
    await this.request<void>(`/status-page/incidents/${id}`, { method: "DELETE" });
  }

  async resolveStatusPageIncident(id: string): Promise<StatusPageIncident> {
    return this.unwrapData(
      this.request<{ data: StatusPageIncident }>(`/status-page/incidents/${id}/resolve`, {
        method: "POST",
      })
    );
  }

  async promoteStatusPageIncident(id: string): Promise<StatusPageIncident> {
    return this.unwrapData(
      this.request<{ data: StatusPageIncident }>(`/status-page/incidents/${id}/promote`, {
        method: "POST",
      })
    );
  }

  async createStatusPageIncidentUpdate(
    id: string,
    data: { message: string; status?: StatusPageIncidentUpdateStatus }
  ): Promise<StatusPageIncidentUpdate> {
    const update = await this.unwrapData(
      this.request<{ data: StatusPageIncidentUpdate }>(`/status-page/incidents/${id}/updates`, {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
    this.invalidateCache("req:/api/status-page/incidents");
    return update;
  }

  async getStatusPagePreview(): Promise<PublicStatusPageDto> {
    return this.unwrapData(this.request<{ data: PublicStatusPageDto }>("/status-page/preview"));
  }

  async createFolder(data: { name: string; parentId?: string }): Promise<ProxyHostFolder> {
    return this.unwrapData(
      this.request<{ data: ProxyHostFolder }>("/proxy-host-folders", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateFolder(id: string, data: { name: string }): Promise<ProxyHostFolder> {
    return this.unwrapData(
      this.request<{ data: ProxyHostFolder }>(`/proxy-host-folders/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async moveFolder(id: string, parentId: string | null): Promise<ProxyHostFolder> {
    return this.unwrapData(
      this.request<{ data: ProxyHostFolder }>(`/proxy-host-folders/${id}/move`, {
        method: "PUT",
        body: JSON.stringify({ parentId }),
      })
    );
  }

  async deleteFolder(id: string): Promise<void> {
    return this.request<void>(`/proxy-host-folders/${id}`, { method: "DELETE" });
  }

  async reorderFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
    return this.request<void>("/proxy-host-folders/reorder", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  async reorderHosts(items: { id: string; sortOrder: number }[]): Promise<void> {
    return this.request<void>("/proxy-host-folders/reorder-hosts", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  async moveHostsToFolder(hostIds: string[], folderId: string | null): Promise<void> {
    return this.request<void>("/proxy-host-folders/move-hosts", {
      method: "POST",
      body: JSON.stringify({ hostIds, folderId }),
    });
  }

  // ── Nginx Config Templates ─────────────────────────────────────

  async listNginxTemplates(): Promise<NginxTemplate[]> {
    return this.unwrapData(this.request<{ data: NginxTemplate[] }>("/nginx-templates"));
  }

  async getNginxTemplate(id: string): Promise<NginxTemplate> {
    return this.unwrapData(this.request<{ data: NginxTemplate }>(`/nginx-templates/${id}`));
  }

  async createNginxTemplate(data: {
    name: string;
    description?: string;
    type: string;
    content: string;
    variables?: TemplateVariableDef[];
  }): Promise<NginxTemplate> {
    return this.unwrapData(
      this.request<{ data: NginxTemplate }>("/nginx-templates", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateNginxTemplate(
    id: string,
    data: {
      name?: string;
      description?: string | null;
      content?: string;
      variables?: TemplateVariableDef[];
    }
  ): Promise<NginxTemplate> {
    return this.unwrapData(
      this.request<{ data: NginxTemplate }>(`/nginx-templates/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async deleteNginxTemplate(id: string): Promise<void> {
    return this.request<void>(`/nginx-templates/${id}`, { method: "DELETE" });
  }

  async cloneNginxTemplate(id: string): Promise<NginxTemplate> {
    return this.unwrapData(
      this.request<{ data: NginxTemplate }>(`/nginx-templates/${id}/clone`, {
        method: "POST",
      })
    );
  }

  async previewNginxTemplate(content: string, hostId?: string): Promise<{ rendered: string }> {
    return this.unwrapData(
      this.request<{ data: { rendered: string } }>("/nginx-templates/preview", {
        method: "POST",
        body: JSON.stringify({ content, hostId }),
      })
    );
  }

  async testNginxTemplate(
    content: string
  ): Promise<{ rendered: string; valid: boolean; errors: string[] }> {
    return this.unwrapData(
      this.request<{ data: { rendered: string; valid: boolean; errors: string[] } }>(
        "/nginx-templates/test",
        {
          method: "POST",
          body: JSON.stringify({ content }),
        }
      )
    );
  }

  // ── SSL Certificates ───────────────────────────────────────────

  async listSSLCertificates(params?: {
    page?: number;
    limit?: number;
    search?: string;
    type?: SSLCertType;
    status?: SSLCertStatus;
    sortBy?: string;
    sortOrder?: string;
    showSystem?: boolean;
  }): Promise<PaginatedResponse<SSLCertificate>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set("page", params.page.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.search) searchParams.set("search", params.search);
    if (params?.type) searchParams.set("type", params.type);
    if (params?.status) searchParams.set("status", params.status);
    if (params?.sortBy) searchParams.set("sortBy", params.sortBy);
    if (params?.sortOrder) searchParams.set("sortOrder", params.sortOrder);
    if (params?.showSystem) searchParams.set("showSystem", "true");

    const query = searchParams.toString();
    return this.request<PaginatedResponse<SSLCertificate>>(
      `/ssl-certificates${query ? `?${query}` : ""}`
    );
  }

  async getSSLCertificate(id: string): Promise<SSLCertificate> {
    return this.unwrapData(this.request<{ data: SSLCertificate }>(`/ssl-certificates/${id}`));
  }

  async requestACMECert(data: RequestACMECertRequest): Promise<SSLCertificateOperationResult> {
    return this.unwrapData(
      this.request<{ data: SSLCertificateOperationResult }>("/ssl-certificates/acme", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async uploadCert(data: UploadCertRequest): Promise<SSLCertificate> {
    return this.unwrapData(
      this.request<{ data: SSLCertificate }>("/ssl-certificates/upload", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async linkInternalCert(data: LinkInternalCertRequest): Promise<SSLCertificate> {
    return this.unwrapData(
      this.request<{ data: SSLCertificate }>("/ssl-certificates/internal", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async renewSSLCert(id: string): Promise<SSLCertificate | SSLCertificateOperationResult> {
    return this.unwrapData(
      this.request<{ data: SSLCertificate | SSLCertificateOperationResult }>(
        `/ssl-certificates/${id}/renew`,
        { method: "POST" }
      )
    );
  }

  async setSSLCertAutoRenew(
    id: string,
    data: { enabled: boolean; provider?: "cloudflare" }
  ): Promise<SSLCertificate> {
    return this.unwrapData(
      this.request<{ data: SSLCertificate }>(`/ssl-certificates/${id}/auto-renew`, {
        method: "PATCH",
        body: JSON.stringify(data),
      })
    );
  }

  async completeDNSVerify(id: string): Promise<SSLCertificate> {
    return this.unwrapData(
      this.request<{ data: SSLCertificate }>(`/ssl-certificates/${id}/dns-verify`, {
        method: "POST",
      })
    );
  }

  async resyncSSLCertificateDistribution(id: string): Promise<{ synchronized: number }> {
    return this.unwrapData(
      this.request<{ data: { synchronized: number } }>(
        `/ssl-certificates/${id}/distribution/resync`,
        {
          method: "POST",
        }
      )
    );
  }

  async deleteSSLCert(id: string): Promise<void> {
    return this.request<void>(`/ssl-certificates/${id}`, { method: "DELETE" });
  }

  // ── Access Lists ───────────────────────────────────────────────

  async listAccessLists(params?: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<PaginatedResponse<AccessList>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set("page", params.page.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.search) searchParams.set("search", params.search);

    const query = searchParams.toString();
    return this.request<PaginatedResponse<AccessList>>(`/access-lists${query ? `?${query}` : ""}`);
  }

  async getAccessList(id: string): Promise<AccessList> {
    return this.unwrapData(this.request<{ data: AccessList }>(`/access-lists/${id}`));
  }

  async createAccessList(data: CreateAccessListRequest): Promise<AccessList> {
    return this.unwrapData(
      this.request<{ data: AccessList }>("/access-lists", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateAccessList(id: string, data: Partial<CreateAccessListRequest>): Promise<AccessList> {
    return this.unwrapData(
      this.request<{ data: AccessList }>(`/access-lists/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async deleteAccessList(id: string): Promise<void> {
    return this.request<void>(`/access-lists/${id}`, { method: "DELETE" });
  }

  // ── Monitoring ─────────────────────────────────────────────────

  async getDashboardStats(showSystem?: boolean): Promise<DashboardStats> {
    return this.unwrapData(
      this.request<{ data: DashboardStats }>(
        `/monitoring/dashboard${showSystem ? "?showSystem=true" : ""}`
      )
    );
  }

  async getDashboardBootstrap(request: DashboardBootstrapRequest): Promise<DashboardBootstrap> {
    const snapshot = await this.unwrapData(
      this.request<{ data: DashboardBootstrap }>("/monitoring/dashboard/bootstrap", {
        method: "POST",
        body: JSON.stringify(request),
      })
    );
    if (snapshot.inferenceUsage) {
      this.setCache(INFERENCE_SELF_USAGE_CACHE_KEY, snapshot.inferenceUsage);
      publishInferenceSelfUsage(snapshot.inferenceUsage);
    }
    return snapshot;
  }

  async getHealthOverview(): Promise<ProxyHost[]> {
    return this.unwrapData(this.request<{ data: ProxyHost[] }>("/monitoring/health-status"));
  }

  // ── SSE (Live Logs) ────────────────────────────────────────────

  createLogStream(hostId: string): EventSource {
    return new EventSource(`${API_BASE}/monitoring/logs/${hostId}/stream`, {
      withCredentials: true,
    });
  }

  createProxyLogStreamWebSocket(hostId: string, tail = 200): WebSocket {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(
      `${proto}//${window.location.host}/api/monitoring/logs/${hostId}/ws?tail=${tail}`
    );
  }

  createNodeNginxLogStreamWebSocket(nodeId: string, tail = 200): WebSocket {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(
      `${proto}//${window.location.host}/api/nodes/${nodeId}/nginx-logs/ws?tail=${tail}`
    );
  }

  // ── Domains ────────────────────────────────────────────────────

  async listDomains(params?: {
    page?: number;
    limit?: number;
    search?: string;
    dnsStatus?: DnsStatus;
  }): Promise<PaginatedResponse<Domain>> {
    const sp = new URLSearchParams();
    if (params?.page) sp.set("page", params.page.toString());
    if (params?.limit) sp.set("limit", params.limit.toString());
    if (params?.search) sp.set("search", params.search);
    if (params?.dnsStatus) sp.set("dnsStatus", params.dnsStatus);
    const q = sp.toString();
    return this.request<PaginatedResponse<Domain>>(`/domains${q ? `?${q}` : ""}`);
  }

  async getDomain(id: string): Promise<DomainWithUsage> {
    return this.unwrapData(this.request<{ data: DomainWithUsage }>(`/domains/${id}`));
  }

  async previewDomain(
    data: Pick<CreateDomainRequest, "domain" | "ttl" | "proxied">
  ): Promise<import("@/types").DomainPreview> {
    return this.unwrapData(
      this.request<{ data: import("@/types").DomainPreview }>("/domains/preview", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async createDomain(data: CreateDomainRequest): Promise<Domain> {
    return this.unwrapData(
      this.request<{ data: Domain }>("/domains", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateDomain(id: string, data: UpdateDomainRequest): Promise<Domain> {
    return this.unwrapData(
      this.request<{ data: Domain }>(`/domains/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async deleteDomain(id: string, data?: DeleteDomainRequest): Promise<void> {
    await this.request<void>(`/domains/${id}`, {
      method: "DELETE",
      body: JSON.stringify(data ?? {}),
    });
  }

  async checkDomainDns(id: string): Promise<Domain> {
    return this.unwrapData(
      this.request<{ data: Domain }>(`/domains/${id}/check-dns`, { method: "POST" })
    );
  }

  async issueDomainCert(id: string): Promise<SSLCertificate> {
    return this.unwrapData(
      this.request<{ data: SSLCertificate }>(`/domains/${id}/issue-cert`, { method: "POST" })
    );
  }

  async listDomainFolders(): Promise<import("@/types").ResourceFolderTreeNode[]> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolderTreeNode[] }>("/domains/folders")
    );
  }

  async createDomainFolder(data: {
    name: string;
    parentId?: string;
  }): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>("/domains/folders", {
        method: "POST",
        body: JSON.stringify(data),
      })
    );
  }

  async updateDomainFolder(
    id: string,
    data: { name: string }
  ): Promise<import("@/types").ResourceFolder> {
    return this.unwrapData(
      this.request<{ data: import("@/types").ResourceFolder }>(`/domains/folders/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      })
    );
  }

  async deleteDomainFolder(id: string): Promise<void> {
    await this.request(`/domains/folders/${id}`, { method: "DELETE" });
  }

  async reorderDomainFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/domains/folders/reorder", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  async moveDomainsToFolder(ids: string[], folderId: string | null): Promise<void> {
    await this.request("/domains/folders/move-domains", {
      method: "POST",
      body: JSON.stringify({ ids, folderId }),
    });
  }

  async reorderDomains(items: { id: string; sortOrder: number }[]): Promise<void> {
    await this.request("/domains/folders/reorder-domains", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  }

  async searchDomains(q: string): Promise<DomainSearchResult[]> {
    return this.unwrapData(
      this.request<{ data: DomainSearchResult[] }>(`/domains/search?q=${encodeURIComponent(q)}`)
    );
  }
}

export const api = new ApiClient();
