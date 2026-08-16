import { ApiClientBase, type ApiRequestError, DEFAULT_CACHE_TTL } from "@/services/api-base";
import { useAppStatusStore } from "@/stores/app-status";

class TestApiClient extends ApiClientBase {
  getThing() {
    return this.request<{ value: number }>("/thing");
  }

  updateThing() {
    return this.request<void>("/thing", { method: "POST", body: JSON.stringify({ ok: true }) });
  }

  executeThing(signal: AbortSignal) {
    return this.request<void>("/thing", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
      signal,
    });
  }

  deleteProxyHost(id: string) {
    return this.request<void>(`/proxy-hosts/${id}`, { method: "DELETE" });
  }

  getRouteContextThing() {
    return this.requestRouteContext<{ value: number }>("/route-context");
  }

  downloadThing(onProgress: (progress: { loaded: number; total: number }) => void) {
    return this.requestBinary("/binary", {}, onProgress);
  }
}

describe("ApiClientBase", () => {
  it("reports caller cancellation without switching the Gateway into maintenance mode", async () => {
    const client = new TestApiClient();
    const abortController = new AbortController();
    abortController.abort();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    await expect(client.executeThing(abortController.signal)).rejects.toMatchObject({
      code: "REQUEST_ABORTED",
      message: "Query cancelled",
    });
    expect(useAppStatusStore.getState().maintenanceActive).toBe(false);
  });

  it("returns fresh GET data and updates the shared cache", async () => {
    const client = new TestApiClient();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: 2 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    expect(await client.getThing()).toEqual({ value: 1 });
    expect(await client.getThing()).toEqual({ value: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.getCached<{ value: number }>("req:/api/thing", DEFAULT_CACHE_TTL)).toEqual({
      value: 2,
    });
  });

  it("shares a concurrent GET instead of issuing duplicate wire requests", async () => {
    const client = new TestApiClient();
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })
    );

    const first = client.getThing();
    const second = client.getThing();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(
      new Response(JSON.stringify({ value: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(Promise.all([first, second])).resolves.toEqual([{ value: 1 }, { value: 1 }]);
  });

  it("detaches invalidated GET work and does not let its late response repopulate the cache", async () => {
    const client = new TestApiClient();
    let resolveStale!: (response: Response) => void;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveStale = resolve;
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: 2 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const stale = client.getThing();
    client.invalidateCache("req:/api/thing");
    await expect(client.getThing()).resolves.toEqual({ value: 2 });
    resolveStale(
      new Response(JSON.stringify({ value: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(stale).resolves.toEqual({ value: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.getCached<{ value: number }>("req:/api/thing")).toEqual({ value: 2 });
  });

  it("invalidates cached GET entries after a mutation", async () => {
    const client = new TestApiClient();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await client.getThing();
    expect(client.getCached("req:/api/thing")).toEqual({ value: 1 });

    await client.updateThing();

    expect(client.getCached("req:/api/thing")).toBeUndefined();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/thing",
      expect.objectContaining({
        credentials: "include",
        headers: expect.any(Headers),
      })
    );
    const headers = (fetchMock.mock.calls[2]?.[1] as RequestInit | undefined)?.headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBe("csrf-token");
  });

  it("invalidates warmed resource projections only after a successful mutation", async () => {
    const client = new TestApiClient();
    client.setCache("req:/api/proxy-hosts?page=1", { data: [{ id: "host-1" }] });
    client.setCache("proxy:grouped", { ungroupedHosts: [{ id: "host-1" }] });
    client.setCache("dashboard:bootstrap:user", { attention: { severity: null } });
    let resolveDelete!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveDelete = resolve;
        })
      );

    const deleting = client.deleteProxyHost("host-1");
    await vi.waitFor(() => expect(resolveDelete).toBeTypeOf("function"));
    expect(client.getCached("proxy:grouped")).toBeDefined();

    resolveDelete(new Response(null, { status: 204 }));
    await deleting;

    expect(client.getCached("req:/api/proxy-hosts?page=1")).toBeUndefined();
    expect(client.getCached("proxy:grouped")).toBeUndefined();
    expect(client.getCached("dashboard:bootstrap:user")).toBeUndefined();
  });

  it("keeps valid cache entries when a mutation fails", async () => {
    const client = new TestApiClient();
    client.setCache("req:/api/proxy-hosts?page=1", { data: [{ id: "host-1" }] });
    client.setCache("proxy:grouped", { ungroupedHosts: [{ id: "host-1" }] });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "CONFLICT", message: "Still in use" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        })
      );

    await expect(client.deleteProxyHost("host-1")).rejects.toMatchObject({ code: "CONFLICT" });

    expect(client.getCached("req:/api/proxy-hosts?page=1")).toBeDefined();
    expect(client.getCached("proxy:grouped")).toBeDefined();
  });

  it("clears cache and rejects responses that complete after a session reset", async () => {
    const client = new TestApiClient();
    client.setCache("req:/api/thing", { value: 1 });
    let resolveFetch: (value: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })
    );

    const request = client.getThing();
    client.resetSessionState();
    resolveFetch(
      new Response(JSON.stringify({ value: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(request).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(client.getCached("req:/api/thing")).toBeUndefined();
  });

  it("rejects and avoids cache writes when the session changes during response parsing", async () => {
    const client = new TestApiClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: async () => {
        client.resetSessionState();
        return { value: 2 };
      },
    } as Response);

    await expect(client.getThing()).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(client.getCached("req:/api/thing")).toBeUndefined();
  });

  it("rejects cachedRequest refreshes that complete after a session reset", async () => {
    const client = new TestApiClient();
    const request = client.cachedRequest("custom:key", async () => {
      client.resetSessionState();
      return { value: 3 };
    });

    await expect(request).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(client.getCached("custom:key")).toBeUndefined();
  });

  it("deduplicates concurrent cache misses and one stale-while-revalidate refresh", async () => {
    const client = new TestApiClient();
    let resolve!: (value: { value: number }) => void;
    const pending = new Promise<{ value: number }>((done) => {
      resolve = done;
    });
    const fetcher = vi.fn(() => pending);

    const first = client.cachedRequest("custom:key", fetcher);
    const second = client.cachedRequest("custom:key", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve({ value: 4 });
    await expect(Promise.all([first, second])).resolves.toEqual([{ value: 4 }, { value: 4 }]);

    const refreshed = new Promise<{ value: number }>(() => {});
    const refreshFetcher = vi.fn(() => refreshed);
    await expect(client.cachedRequest("custom:key", refreshFetcher)).resolves.toEqual({ value: 4 });
    await expect(client.cachedRequest("custom:key", refreshFetcher)).resolves.toEqual({ value: 4 });
    expect(refreshFetcher).toHaveBeenCalledTimes(1);
  });

  it("does not restore an invalidated cachedRequest result after its fetcher settles", async () => {
    const client = new TestApiClient();
    let resolve!: (value: { value: number }) => void;
    const pending = new Promise<{ value: number }>((done) => {
      resolve = done;
    });

    const stale = client.cachedRequest("custom:key", () => pending);
    client.invalidateCache("custom:");
    resolve({ value: 1 });

    await expect(stale).resolves.toEqual({ value: 1 });
    expect(client.getCached("custom:key")).toBeUndefined();
  });

  it("sends cookie credentials and no session Authorization header", async () => {
    const client = new TestApiClient();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ value: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await client.getThing();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/thing",
      expect.objectContaining({
        credentials: "include",
        headers: expect.any(Headers),
      })
    );
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Headers;
    expect(headers.has("Authorization")).toBe(false);
  });

  it("reports streamed binary download progress until the response is complete", async () => {
    const client = new TestApiClient();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { "Content-Length": "5" },
      })
    );
    const progress = vi.fn();

    const bytes = await client.downloadThing(progress);

    expect(Array.from(new Uint8Array(bytes))).toEqual([1, 2, 3, 4, 5]);
    expect(progress.mock.calls).toEqual([
      [{ loaded: 0, total: 5 }],
      [{ loaded: 2, total: 5 }],
      [{ loaded: 5, total: 5 }],
    ]);
  });

  it("preserves JSON error details and does not enter maintenance mode for ordinary 5xx API responses", async () => {
    const client = new TestApiClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "UNTRUSTED_UPDATE_ARTIFACT",
          message: "Gateway update artifact is not trusted",
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(client.getThing()).rejects.toMatchObject({
      message: "Gateway update artifact is not trusted",
      status: 502,
      code: "UNTRUSTED_UPDATE_ARTIFACT",
    } satisfies Partial<ApiRequestError>);
    expect(useAppStatusStore.getState().maintenanceActive).toBe(false);
  });

  it("opens the restart screen for SERVICE_RESTARTING responses", async () => {
    const client = new TestApiClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "SERVICE_RESTARTING",
          message: "Gateway is restarting",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(client.getThing()).rejects.toMatchObject({
      status: 503,
      code: "SERVICE_RESTARTING",
    } satisfies Partial<ApiRequestError>);
    expect(useAppStatusStore.getState()).toMatchObject({
      gatewayRestartingActive: true,
      gatewayRestartTargetUrl: null,
    });
  });

  it("enters maintenance mode on a real network-level fetch failure", async () => {
    const client = new TestApiClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(client.getThing()).rejects.toMatchObject({
      status: 0,
      code: "SERVICE_UNAVAILABLE",
    } satisfies Partial<ApiRequestError>);
    expect(useAppStatusStore.getState().maintenanceActive).toBe(true);
  });

  it("keeps maintenance latched when an unrelated request succeeds", async () => {
    const client = new TestApiClient();
    useAppStatusStore.setState({ maintenanceActive: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ value: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(client.getThing()).resolves.toEqual({ value: 1 });
    expect(useAppStatusStore.getState().maintenanceActive).toBe(true);
  });

  it("keeps route-context failures local instead of opening global blockers", async () => {
    const client = new TestApiClient();
    useAppStatusStore.setState({ maintenanceActive: false, rateLimitedUntil: null });
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(null, { status: 429 }));

    await expect(client.getRouteContextThing()).rejects.toMatchObject({
      status: 0,
      code: "SERVICE_UNAVAILABLE",
    } satisfies Partial<ApiRequestError>);
    await expect(client.getRouteContextThing()).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMIT_EXCEEDED",
    } satisfies Partial<ApiRequestError>);

    expect(useAppStatusStore.getState()).toMatchObject({
      maintenanceActive: false,
      rateLimitedUntil: null,
    });
  });

  it("opens the rate-limit blocker with a 60-second fallback window", async () => {
    const client = new TestApiClient();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 429 }));

    await expect(client.getThing()).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMIT_EXCEEDED",
      retryAfterSeconds: 60,
    } satisfies Partial<ApiRequestError>);

    expect(useAppStatusStore.getState().rateLimitedUntil).toBe(Date.now() + 60_000);

    vi.useRealTimers();
  });
});
