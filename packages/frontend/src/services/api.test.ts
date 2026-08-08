import { INFERENCE_SELF_USAGE_UPDATED_EVENT } from "@/lib/inference-self-usage";
import { api } from "@/services/api";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function lastJsonBody(fetchMock: ReturnType<typeof vi.spyOn>) {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return init?.body ? JSON.parse(String(init.body)) : undefined;
}

describe("api client contract", () => {
  beforeEach(() => {
    api.resetSessionState();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    api.resetSessionState();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("marks only focused node monitoring streams as focused", () => {
    const eventSource = vi.fn(function EventSourceMock() {
      return { close: vi.fn() };
    });
    vi.stubGlobal("EventSource", eventSource);

    api.createNodeMonitoringStream("node-1");
    api.createNodeMonitoringStream("node-1", { focused: true });

    expect(eventSource).toHaveBeenNthCalledWith(1, "/api/nodes/node-1/monitoring/stream", {
      withCredentials: true,
    });
    expect(eventSource).toHaveBeenNthCalledWith(
      2,
      "/api/nodes/node-1/monitoring/stream?focused=true",
      { withCredentials: true }
    );
  });

  it("lists managed GPU users for a Docker node", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            deviceId: "nvidia:gpu-1",
            containerCount: 1,
            containers: [{ name: "inference" }],
          },
        ],
      })
    );

    await expect(api.listDockerGpuUsage("node-1")).resolves.toEqual([
      {
        deviceId: "nvidia:gpu-1",
        containerCount: 1,
        containers: [{ name: "inference" }],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/docker/nodes/node-1/containers/gpu-usage", {
      credentials: "include",
      headers: expect.any(Headers),
    });
  });

  it("serializes proxy host list filters and unwraps proxy host mutations", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "proxy-1", domainNames: ["app.example.com"] }],
          total: 1,
          page: 2,
        })
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "proxy-1", accessListId: null } }));

    await expect(
      api.listProxyHosts({
        page: 2,
        limit: 50,
        search: "app",
        type: "proxy",
        healthStatus: "online",
        enabled: false,
        sortBy: "domainNames",
        sortOrder: "asc",
        nodeId: "node-1",
      })
    ).resolves.toMatchObject({ total: 1, page: 2 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/proxy-hosts?page=2&limit=50&search=app&type=proxy&healthStatus=online&enabled=false&sortBy=domainNames&sortOrder=asc&nodeId=node-1"
    );

    await expect(api.updateProxyHost("proxy-1", { accessListId: null })).resolves.toEqual({
      id: "proxy-1",
      accessListId: null,
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/proxy-hosts/proxy-1");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "PUT" });
    expect(lastJsonBody(fetchMock)).toEqual({ accessListId: null });
  });

  it("reads and updates user AI preferences through the auth preferences endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ aiApprovalMode: "normal" }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ aiApprovalMode: "bypass-non-destructive" }));

    await expect(api.getUserPreferences()).resolves.toEqual({ aiApprovalMode: "normal" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/auth/me/preferences");

    await expect(
      api.updateUserPreferences({ aiApprovalMode: "bypass-non-destructive" })
    ).resolves.toEqual({
      aiApprovalMode: "bypass-non-destructive",
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/auth/me/preferences");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "PATCH" });
    expect(lastJsonBody(fetchMock)).toEqual({ aiApprovalMode: "bypass-non-destructive" });
    expect(api.getCached("auth:me:preferences")).toEqual({
      aiApprovalMode: "bypass-non-destructive",
    });
  });

  it("publishes fresh inference usage to every mounted usage surface", async () => {
    const usage = {
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
        "7d": { configured: true, percentage: 99, recoveryAt: "2030-01-07T00:00:00.000Z" },
        "30d": {
          configured: false,
          percentage: 0,
          recoveryAt: "2030-01-30T00:00:00.000Z",
        },
      },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(usage));
    const onUsage = vi.fn();
    window.addEventListener(INFERENCE_SELF_USAGE_UPDATED_EVENT, onUsage);

    await expect(api.getInferenceSelfUsage()).resolves.toEqual(usage);

    expect(onUsage).toHaveBeenCalledOnce();
    expect((onUsage.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(usage);
    window.removeEventListener(INFERENCE_SELF_USAGE_UPDATED_EVENT, onUsage);
  });

  it("warms inference usage from the shared dashboard bootstrap response", async () => {
    const usage = {
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
        "7d": { configured: true, percentage: 25, recoveryAt: "2030-01-07T00:00:00.000Z" },
        "30d": { configured: false, percentage: 0, recoveryAt: "2030-01-30T00:00:00.000Z" },
      },
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ data: { inferenceUsage: usage } }));
    const onUsage = vi.fn();
    window.addEventListener(INFERENCE_SELF_USAGE_UPDATED_EVENT, onUsage);

    await api.getDashboardBootstrap({});

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/monitoring/dashboard/bootstrap");
    expect(api.getCached("req:/api/inference/usage/self")).toEqual(usage);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ detail: usage }));
    window.removeEventListener(INFERENCE_SELF_USAGE_UPDATED_EVENT, onUsage);
  });

  it("replaces a user's exact additional permissions", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "user-1",
          additionalScopes: ["nodes:console:node-1"],
        })
      );

    await expect(
      api.updateUserAdditionalPermissions("user-1", ["nodes:console:node-1"])
    ).resolves.toMatchObject({
      id: "user-1",
      additionalScopes: ["nodes:console:node-1"],
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/admin/users/user-1/additional-permissions");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "PUT" });
    expect(lastJsonBody(fetchMock)).toEqual({
      additionalScopes: ["nodes:console:node-1"],
    });
  });

  it("serializes oauth consent and authorization requests", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          client: { id: "client 1", name: "Codex" },
          scopes: ["proxy:hosts:view"],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ redirectUrl: "/oauth/callback?ok=1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { clientId: "client 1", resource: "https://mcp.example/one", scopes: ["a"] },
        })
      );

    await expect(api.getOAuthConsent("request 1/2")).resolves.toMatchObject({
      client: { id: "client 1" },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/oauth/consent/request%201%2F2");

    await expect(api.approveOAuthConsent("request 1/2", ["proxy:hosts:view"])).resolves.toEqual({
      redirectUrl: "/oauth/callback?ok=1",
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/oauth/consent/request%201%2F2/approve");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
      scopes: ["proxy:hosts:view"],
    });

    await expect(
      api.updateOAuthAuthorization("client 1", "https://mcp.example/one", ["a"])
    ).resolves.toMatchObject({ clientId: "client 1", resource: "https://mcp.example/one" });
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "/api/oauth/authorizations/client%201?resource=https%3A%2F%2Fmcp.example%2Fone"
    );
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: "PATCH" });
    expect(lastJsonBody(fetchMock)).toEqual({ scopes: ["a"] });
  });

  it("serializes postgres row queries and mutations without changing value types", async () => {
    const primaryKey = { id: 7 };
    const values = { amount: 42, enabled: true, status: "ready", happenedAt: "2026-06-21" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            metadata: { columns: [] },
            rows: [{ id: 7 }],
            total: 1,
            page: 3,
            limit: 25,
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 7, ...values } }));

    await expect(
      api.browsePostgresRows("db-1", {
        schema: "public",
        table: "orders",
        page: 3,
        limit: 25,
        sortBy: "created_at",
        sortOrder: "desc",
        searchColumn: "status",
        searchOperation: "equals",
        searchValue: "ready",
      })
    ).resolves.toMatchObject({ total: 1, page: 3, limit: 25 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/databases/db-1/postgres/rows?schema=public&table=orders&page=3&limit=25&sortBy=created_at&sortOrder=desc&searchColumn=status&searchOperation=equals&searchValue=ready"
    );

    await expect(
      api.updatePostgresRow("db-1", "public", "orders", primaryKey, values)
    ).resolves.toMatchObject({ id: 7, amount: 42 });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/databases/db-1/postgres/rows");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "PATCH" });
    expect(lastJsonBody(fetchMock)).toEqual({
      schema: "public",
      table: "orders",
      primaryKey,
      values,
    });
  });

  it("serializes provider-neutral SQL browsing and execution requests", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            metadata: { provider: "clickhouse", columns: [] },
            rows: [],
            total: null,
            totalKind: "unavailable",
            page: 2,
            limit: 100,
            truncated: false,
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { results: [], truncated: false, resultLimit: 10 } })
      )
      .mockResolvedValueOnce(jsonResponse({ data: { success: true, affectedRows: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { success: true, affectedRows: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { success: true, affectedRows: 1 } }));

    await api.browseSqlRows("clickhouse-1", {
      namespace: "analytics",
      table: "events",
      page: 2,
      limit: 100,
      sortBy: "event_id",
      sortOrder: "desc",
      searchColumn: "name",
      searchOperation: "like",
      searchValue: "signup",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/databases/clickhouse-1/sql/rows?namespace=analytics&table=events&page=2&limit=100&sortBy=event_id&sortOrder=desc&searchColumn=name&searchOperation=like&searchValue=signup"
    );

    await api.executeSql("clickhouse-1", "select 1");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/databases/clickhouse-1/sql/query");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(lastJsonBody(fetchMock)).toEqual({ sql: "select 1", maxRows: 500 });

    await api.insertSqlRow("clickhouse-1", "analytics", "events", { event_id: 2 });
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/databases/clickhouse-1/sql/rows");
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: "POST" });

    await api.updateSqlRow(
      "clickhouse-1",
      "analytics",
      "events",
      { event_id: 2 },
      { name: "purchase" }
    );
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: "PATCH" });

    await api.deleteSqlRow("clickhouse-1", "analytics", "events", { event_id: 2 });
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({ method: "DELETE" });
    expect(lastJsonBody(fetchMock)).toEqual({
      namespace: "analytics",
      table: "events",
      locator: { event_id: 2 },
    });
  });

  it("serializes PKI CA, certificate, and template requests", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ id: "ca-1", name: "Root" }]))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "cert-1", status: "revoked" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "template-1", name: "Server" } }));

    await expect(api.listCAs({ showSystem: true })).resolves.toEqual([
      { id: "ca-1", name: "Root" },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/cas?showSystem=true");

    await expect(api.revokeCertificate("cert-1", "key_compromise")).resolves.toEqual({
      data: { id: "cert-1", status: "revoked" },
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/certificates/cert-1/revoke");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(lastJsonBody(fetchMock)).toEqual({ reason: "key_compromise" });

    await expect(api.createTemplate({ name: "Server" })).resolves.toEqual({
      data: { id: "template-1", name: "Server" },
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/templates");
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: "POST" });
    expect(lastJsonBody(fetchMock)).toEqual({ name: "Server" });
  });

  it("exports PKI blobs through the shared binary request path", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "application/x-pkcs12" },
        })
      );

    await expect(api.exportCertificate("cert-1", "pkcs12")).rejects.toThrow(
      "Passphrase required for PKCS#12 export"
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const blob = await api.exportCertificate("cert-1", "pkcs12", "secret-passphrase");

    expect(blob.type).toBe("application/x-pkcs12");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/auth/csrf");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/certificates/cert-1/export");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    const headers = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBe("csrf-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      format: "pkcs12",
      passphrase: "secret-passphrase",
    });
  });

  it("surfaces structured PKI binary export errors", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        jsonResponse(
          { code: "PASSPHRASE_REQUIRED", message: "Passphrase required for PKCS#12 export" },
          { status: 400 }
        )
      );

    await expect(
      api.exportCertificate("cert-1", "pkcs12", "secret-passphrase")
    ).rejects.toMatchObject({
      message: "Passphrase required for PKCS#12 export",
      status: 400,
      code: "PASSPHRASE_REQUIRED",
    });
  });

  it("adds docker list metadata and supports cache-busting container inspect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T12:00:00Z"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "container-1", name: "api" }],
          total: 120,
          limit: 50,
          truncated: true,
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: { id: "container-1", name: "api" } }));

    await expect(
      api.listDockerContainers("node-1", { search: "api", noCache: true })
    ).resolves.toEqual([
      {
        id: "container-1",
        name: "api",
        _listTotal: 120,
        _listLimit: 50,
        _listTruncated: true,
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/docker/nodes/node-1/containers?search=api&_t=1782043200000"
    );

    await expect(api.inspectContainer("node-1", "container-1", true)).resolves.toEqual({
      id: "container-1",
      name: "api",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/docker/nodes/node-1/containers/container-1?_t=1782043200000"
    );
  });

  it("requests an authoritative container archive import plan", async () => {
    const plan = {
      networks: [{ id: "bridge", name: "bridge", driver: "bridge", scope: "local" }],
      volumes: [],
      resolution: {
        networks: { source: "bridge" },
        createNetworks: [],
        volumes: {},
        createVolumes: [],
        ports: { "8080/tcp:8080": 0 },
      },
      conflictingPorts: ["8080/tcp:8080"],
    };
    const metadata = {
      networks: [{ name: "source", driver: "bridge", createable: false }],
      mounts: [],
      ports: [{ containerPort: 8080, hostPort: 8080, protocol: "tcp" as const }],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ data: plan }));

    await expect(api.planContainerArchiveImport("node-1", metadata)).resolves.toEqual(plan);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/docker/nodes/node-1/containers/archive/plan");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(lastJsonBody(fetchMock)).toEqual(metadata);
  });

  it("reads Docker inventory through aggregate snapshots and sends refresh hints", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ Id: "container-1", Name: "api", NodeId: "node-1", Availability: "unavailable" }],
          nodes: [{ id: "node-1", displayName: "Offline node", slug: "offline" }],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ accepted: true }, { status: 202 }));

    await expect(api.listDockerContainerSnapshots({ search: "api" })).resolves.toMatchObject([
      {
        id: "container-1",
        name: "api",
        nodeId: "node-1",
        availability: "unavailable",
        _nodeName: "Offline node",
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/docker/containers?search=api");

    await api.refreshDockerSnapshots({ resource: "containers", nodeId: "node-1" });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/docker/snapshots/refresh");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ resource: "containers", nodeId: "node-1" }),
    });
  });

  it("serializes docker webhook, image cleanup, and sync pull requests", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: null }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "webhook-1", enabled: true } }))
      .mockResolvedValueOnce(jsonResponse({ data: { enabled: false, retentionCount: 2 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { enabled: true, retentionCount: 5 } }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { success: true, imageRef: "team/api:latest" } })
      );

    await expect(api.getContainerWebhook("node-1", "api/service")).resolves.toBeNull();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/docker/nodes/node-1/containers/api%2Fservice/webhook"
    );

    await expect(
      api.upsertContainerWebhook("node-1", "api/service", { enabled: true })
    ).resolves.toMatchObject({ id: "webhook-1", enabled: true });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "/api/docker/nodes/node-1/containers/api%2Fservice/webhook"
    );
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "PUT" });
    expect(lastJsonBody(fetchMock)).toEqual({ enabled: true });

    await expect(api.getDeploymentImageCleanup("node-1", "deployment-1")).resolves.toEqual({
      enabled: false,
      retentionCount: 2,
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "/api/docker/nodes/node-1/deployments/deployment-1/image-cleanup"
    );

    await expect(
      api.upsertDeploymentImageCleanup("node-1", "deployment-1", {
        enabled: true,
        retentionCount: 5,
      })
    ).resolves.toEqual({ enabled: true, retentionCount: 5 });
    expect(fetchMock.mock.calls[4]?.[0]).toBe(
      "/api/docker/nodes/node-1/deployments/deployment-1/image-cleanup"
    );
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: "PUT" });
    expect(lastJsonBody(fetchMock)).toEqual({ enabled: true, retentionCount: 5 });

    await expect(api.pullImageSync("node-1", "team/api:latest", "registry-1")).resolves.toEqual({
      success: true,
      imageRef: "team/api:latest",
    });
    expect(fetchMock.mock.calls[5]?.[0]).toBe("/api/docker/nodes/node-1/images/pull-sync");
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({ method: "POST" });
    expect(lastJsonBody(fetchMock)).toEqual({
      imageRef: "team/api:latest",
      registryId: "registry-1",
    });
  });

  it("serializes notification alert, webhook, and delivery requests", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "rule-1", name: "CPU High" }],
          total: 1,
          page: 2,
          limit: 25,
          totalPages: 1,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "webhook-1", name: "Ops", enabled: false }],
          total: 1,
          page: 1,
          limit: 10,
          totalPages: 1,
        })
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "rule-1", enabled: false } }))
      .mockResolvedValueOnce(jsonResponse({ data: { rendered: '{"ok":true}', context: {} } }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { total: 3, success: 2, failed: 1, retrying: 0 } })
      );

    await expect(
      api.listAlertRules({
        page: 2,
        limit: 25,
        type: "threshold",
        enabled: false,
        search: "cpu",
      })
    ).resolves.toMatchObject({ total: 1, page: 2 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/notifications/alert-rules?page=2&limit=25&type=threshold&enabled=false&search=cpu"
    );

    await expect(api.listWebhooks({ enabled: false, search: "ops" })).resolves.toMatchObject({
      total: 1,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/notifications/webhooks?enabled=false&search=ops"
    );

    await expect(api.updateAlertRule("rule-1", { enabled: false })).resolves.toMatchObject({
      id: "rule-1",
      enabled: false,
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/notifications/alert-rules/rule-1");
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: "PUT" });
    expect(lastJsonBody(fetchMock)).toEqual({ enabled: false });

    await expect(api.previewWebhookTemplate('{"ok":true}')).resolves.toMatchObject({
      rendered: '{"ok":true}',
    });
    expect(fetchMock.mock.calls[4]?.[0]).toBe("/api/notifications/webhooks/preview");
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: "POST" });
    expect(lastJsonBody(fetchMock)).toEqual({ bodyTemplate: '{"ok":true}' });

    await expect(api.getDeliveryStats("webhook-1")).resolves.toEqual({
      total: 3,
      success: 2,
      failed: 1,
      retrying: 0,
    });
    expect(fetchMock.mock.calls[5]?.[0]).toBe(
      "/api/notifications/deliveries/stats?webhookId=webhook-1"
    );
  });

  it("serializes logging environment, search, and facets requests", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "env-1", name: "Production" }] }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: "log-1", message: "hello" }], nextCursor: "cursor-2" })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            severities: [{ severity: "info", count: 3 }],
            services: [{ service: "api", count: 2 }],
            sources: [],
            traceIds: [],
            spanIds: [],
            requestIds: [],
            labelKeys: [],
            fieldKeys: [],
          },
        })
      );

    await expect(api.listLoggingEnvironments({ search: "prod" })).resolves.toEqual([
      { id: "env-1", name: "Production" },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/logging/environments?search=prod");

    await expect(
      api.searchLogs("env-1", {
        message: "hello",
        limit: 25,
        fields: { status: { op: "eq", value: 200 } },
      })
    ).resolves.toEqual({ data: [{ id: "log-1", message: "hello" }], nextCursor: "cursor-2" });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/logging/environments/env-1/search");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(lastJsonBody(fetchMock)).toEqual({
      limit: 25,
      message: "hello",
      fields: { status: { op: "eq", value: 200 } },
    });

    await expect(
      api.getLoggingFacets("env-1", {
        from: "2026-06-21T00:00:00.000Z",
        to: "2026-06-21T01:00:00.000Z",
      })
    ).resolves.toMatchObject({ severities: [{ severity: "info", count: 3 }] });
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "/api/logging/environments/env-1/facets?from=2026-06-21T00%3A00%3A00.000Z&to=2026-06-21T01%3A00%3A00.000Z"
    );
  });

  it("serializes system, license, and housekeeping requests", async () => {
    const housekeepingConfig = { enabled: true, retentionDays: 14 };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: { version: "2.4.0", updateAvailable: false } }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { status: "scheduled", targetVersion: "2.4.1" } })
      )
      .mockResolvedValueOnce(jsonResponse({ data: { tier: "enterprise", active: true } }))
      .mockResolvedValueOnce(jsonResponse({ data: { tier: "enterprise", active: true } }))
      .mockResolvedValueOnce(jsonResponse({ data: housekeepingConfig }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "run-1", status: "completed" } }));

    await expect(api.getVersionInfo()).resolves.toMatchObject({ version: "2.4.0" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/system/version");

    await expect(api.triggerUpdate("2.4.1")).resolves.toEqual({
      status: "scheduled",
      targetVersion: "2.4.1",
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/system/update");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
      version: "2.4.1",
    });

    await expect(api.getLicenseStatus()).resolves.toMatchObject({ tier: "enterprise" });
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/system/license/status");

    await expect(api.activateLicense("license-key")).resolves.toMatchObject({ active: true });
    expect(fetchMock.mock.calls[4]?.[0]).toBe("/api/system/license/activate");
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String((fetchMock.mock.calls[4]?.[1] as RequestInit).body))).toEqual({
      licenseKey: "license-key",
    });

    await expect(api.updateHousekeepingConfig(housekeepingConfig)).resolves.toEqual(
      housekeepingConfig
    );
    expect(fetchMock.mock.calls[5]?.[0]).toBe("/api/housekeeping/config");
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({ method: "PUT" });
    expect(lastJsonBody(fetchMock)).toEqual(housekeepingConfig);

    await expect(api.runHousekeeping()).resolves.toMatchObject({ id: "run-1" });
    expect(fetchMock.mock.calls[6]?.[0]).toBe("/api/housekeeping/run");
    expect(fetchMock.mock.calls[6]?.[1]).toMatchObject({ method: "POST" });
  });
});
