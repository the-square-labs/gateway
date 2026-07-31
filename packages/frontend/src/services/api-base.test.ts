import { ApiClientBase, type ApiRequestError, DEFAULT_CACHE_TTL } from "@/services/api-base";
import { useAppStatusStore } from "@/stores/app-status";

class TestApiClient extends ApiClientBase {
  getThing() {
    return this.request<{ value: number }>("/thing");
  }

  updateThing() {
    return this.request<void>("/thing", { method: "POST", body: JSON.stringify({ ok: true }) });
  }

  getRouteContextThing() {
    return this.requestRouteContext<{ value: number }>("/route-context");
  }

  downloadThing(onProgress: (progress: { loaded: number; total: number }) => void) {
    return this.requestBinary("/binary", {}, onProgress);
  }
}

describe("ApiClientBase", () => {
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

  it("enters maintenance mode on a real network-level fetch failure", async () => {
    const client = new TestApiClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(client.getThing()).rejects.toMatchObject({
      status: 0,
      code: "SERVICE_UNAVAILABLE",
    } satisfies Partial<ApiRequestError>);
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
