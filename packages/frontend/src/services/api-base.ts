import { useAppStatusStore } from "@/stores/app-status";
import { useAuthStore } from "@/stores/auth";
import type { ApiError } from "@/types";

const API_BASE = "/api";

interface CacheEntry<T = unknown> {
  data: T;
  timestamp: number;
}

const DEFAULT_CACHE_TTL = 60_000; // 1 minute

export { API_BASE, DEFAULT_CACHE_TTL };

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    {
      status,
      code,
      details,
      retryAfterSeconds,
    }: { status: number; code?: string; details?: unknown; retryAfterSeconds?: number }
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function extractApiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const candidate = payload as {
    code?: unknown;
    message?: unknown;
    error?: unknown;
    details?: unknown;
  };
  const firstDetailMessage = Array.isArray(candidate.details)
    ? candidate.details.find(
        (detail): detail is { message: string } =>
          !!detail &&
          typeof detail === "object" &&
          typeof (detail as { message?: unknown }).message === "string" &&
          Boolean((detail as { message: string }).message.trim())
      )?.message
    : undefined;

  if (
    candidate.code === "VALIDATION_ERROR" &&
    typeof firstDetailMessage === "string" &&
    firstDetailMessage.trim()
  ) {
    return firstDetailMessage;
  }
  if (typeof candidate.message === "string" && candidate.message.trim()) {
    return candidate.message;
  }
  if (typeof candidate.error === "string" && candidate.error.trim()) {
    return candidate.error;
  }
  if (candidate.error && typeof candidate.error === "object") {
    const nested = candidate.error as { message?: unknown; error?: unknown };
    if (typeof nested.message === "string" && nested.message.trim()) {
      return nested.message;
    }
    if (typeof nested.error === "string" && nested.error.trim()) {
      return nested.error;
    }
  }
  if (typeof firstDetailMessage === "string" && firstDetailMessage.trim())
    return firstDetailMessage;
  return fallback;
}

function getRetryAfterSeconds(response: Response): number {
  const retryAfter = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;

  const resetAt = Number(response.headers.get("X-RateLimit-Reset"));
  if (Number.isFinite(resetAt) && resetAt > 0) {
    return Math.max(1, Math.ceil(resetAt - Date.now() / 1000));
  }

  return 60;
}

function getXhrRetryAfterSeconds(xhr: XMLHttpRequest): number {
  const retryAfter = Number(xhr.getResponseHeader("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;

  const resetAt = Number(xhr.getResponseHeader("X-RateLimit-Reset"));
  if (Number.isFinite(resetAt) && resetAt > 0) {
    return Math.max(1, Math.ceil(resetAt - Date.now() / 1000));
  }

  return 60;
}

function getLoginRedirectUrl(): string {
  if (window.location.pathname.startsWith("/oauth/")) {
    return `/auth/login?return_to=${encodeURIComponent(window.location.href)}`;
  }
  return "/login";
}

export class ApiClientBase {
  protected cache = new Map<string, CacheEntry>();
  private readonly cacheInflight = new Map<string, Promise<unknown>>();
  private csrfToken: string | null = null;
  private sessionGeneration = 0;

  private assertSessionGeneration(generation: number): void {
    if (generation !== this.sessionGeneration) {
      throw new ApiRequestError("Session changed", {
        status: 0,
        code: "SESSION_CHANGED",
      });
    }
  }

  /** Get cached data if fresh enough. */
  getCached<T>(key: string, ttl = DEFAULT_CACHE_TTL): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > ttl) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  /** Store data in cache. */
  setCache<T>(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /** Invalidate a specific cache key or prefix. */
  invalidateCache(prefix?: string): void {
    if (!prefix) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  resetSessionState(): void {
    this.cache.clear();
    this.cacheInflight.clear();
    this.csrfToken = null;
    this.sessionGeneration += 1;
  }

  /**
   * Fetch with cache: returns cached data if available, fetches in background to update.
   * Returns [data, isFromCache].
   */
  async cachedRequest<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl = DEFAULT_CACHE_TTL
  ): Promise<T> {
    const generation = this.sessionGeneration;
    const cached = this.getCached<T>(key, ttl);
    const existing = this.cacheInflight.get(key) as Promise<T> | undefined;
    const fresh =
      existing ??
      (() => {
        const request = fetcher()
          .then((data) => {
            this.assertSessionGeneration(generation);
            this.setCache(key, data);
            return data;
          })
          .finally(() => {
            if (this.cacheInflight.get(key) === request) this.cacheInflight.delete(key);
          });
        this.cacheInflight.set(key, request);
        return request;
      })();

    // Cached values keep layout stable while exactly one shared refresh runs.
    // Consume background errors here; a later foreground caller can retry.
    if (cached !== undefined) {
      void fresh.catch(() => {});
      return cached;
    }
    return fresh;
  }

  protected getHeaders(): HeadersInit {
    return {
      "Content-Type": "application/json",
    };
  }

  clearCsrfToken(): void {
    this.csrfToken = null;
  }

  private async getCsrfToken(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    const generation = this.sessionGeneration;

    const response = await fetch("/auth/csrf", {
      cache: "no-store",
      credentials: "include",
      headers: this.getHeaders(),
    });

    if (response.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = getLoginRedirectUrl();
      throw new ApiRequestError("Session expired", {
        status: response.status,
        code: "UNAUTHORIZED",
      });
    }

    if (!response.ok) {
      throw new ApiRequestError("Unable to prepare request", {
        status: response.status,
        code: "CSRF_TOKEN_UNAVAILABLE",
      });
    }

    const body = (await response.json()) as { csrfToken?: string };
    if (!body.csrfToken) {
      throw new ApiRequestError("Unable to prepare request", {
        status: response.status,
        code: "CSRF_TOKEN_UNAVAILABLE",
      });
    }

    this.assertSessionGeneration(generation);

    this.csrfToken = body.csrfToken;
    return body.csrfToken;
  }

  protected async fetchRaw<T>(
    url: string,
    options: RequestInit = {},
    { suppressGlobalStatus = false }: { suppressGlobalStatus?: boolean } = {}
  ): Promise<T> {
    let response: Response;
    const generation = this.sessionGeneration;
    const method = (options.method || "GET").toUpperCase();
    const headers = new Headers(this.getHeaders());
    if (options.headers) {
      new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    }
    if (options.body instanceof FormData) {
      headers.delete("Content-Type");
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers.set("X-CSRF-Token", await this.getCsrfToken());
    }

    try {
      response = await fetch(url, {
        ...options,
        credentials: "include",
        headers,
      });
    } catch {
      if (!suppressGlobalStatus) {
        useAppStatusStore.getState().setMaintenanceActive(true);
      }
      throw new ApiRequestError("Service unavailable", {
        status: 0,
        code: "SERVICE_UNAVAILABLE",
      });
    }

    if (response.status < 500 && !suppressGlobalStatus) {
      useAppStatusStore.getState().setMaintenanceActive(false);
    }

    this.assertSessionGeneration(generation);

    if (!response.ok) {
      if (response.status >= 500) {
        const parsedError = await response.json().catch(() => ({
          code: "SERVICE_UNAVAILABLE",
          message: "Service unavailable",
        }));
        const error: ApiError =
          parsedError && typeof parsedError === "object"
            ? (parsedError as ApiError)
            : { code: "SERVICE_UNAVAILABLE", message: "Service unavailable" };
        throw new ApiRequestError(extractApiErrorMessage(parsedError, "Service unavailable"), {
          status: response.status,
          code: error.code || "SERVICE_UNAVAILABLE",
          details: error.details,
        });
      }

      if (response.status === 429) {
        const retryAfterSeconds = getRetryAfterSeconds(response);
        if (!suppressGlobalStatus) {
          useAppStatusStore.getState().activateRateLimit(retryAfterSeconds);
        }
        throw new ApiRequestError("Too many requests, please try again later", {
          status: response.status,
          code: "RATE_LIMIT_EXCEEDED",
          retryAfterSeconds,
        });
      }

      if (response.status === 401) {
        this.clearCsrfToken();
        useAuthStore.getState().logout();
        window.location.href = getLoginRedirectUrl();
        throw new ApiRequestError("Session expired", {
          status: response.status,
          code: "UNAUTHORIZED",
        });
      }

      if (response.status === 403) {
        const body = await response.json().catch(() => ({ message: "" }));
        if (body.message === "Invalid CSRF token") {
          this.clearCsrfToken();
        }
        if (body.message === "Account is blocked") {
          window.location.href = "/blocked";
          throw new ApiRequestError("Account is blocked", {
            status: response.status,
            code: "ACCOUNT_BLOCKED",
          });
        }
        throw new ApiRequestError(extractApiErrorMessage(body, "Insufficient permissions"), {
          status: response.status,
          code: "FORBIDDEN",
        });
      }

      const error: ApiError = await response.json().catch(() => ({
        code: "UNKNOWN_ERROR",
        message: "An unknown error occurred",
      }));

      throw new ApiRequestError(extractApiErrorMessage(error, "An unknown error occurred"), {
        status: response.status,
        code: error.code,
        details: error.details,
      });
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const data = (await response.json()) as T;
    this.assertSessionGeneration(generation);
    return data;
  }

  protected async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url =
      endpoint.startsWith("/auth") || endpoint.startsWith(API_BASE)
        ? endpoint
        : `${API_BASE}${endpoint}`;
    const method = (options.method || "GET").toUpperCase();

    // For GET requests, update the shared cache but return the network result
    // to the caller. Stores already read cache explicitly when they want an
    // instant stale value; returning cached data here makes refresh actions
    // look successful while leaving the UI stale.
    if (method === "GET") {
      const generation = this.sessionGeneration;
      const cacheKey = `req:${url}`;
      const existing = this.cacheInflight.get(cacheKey) as Promise<T> | undefined;
      if (existing) return existing;
      const request = this.fetchRaw<T>(url, options)
        .then((data) => {
          this.assertSessionGeneration(generation);
          this.setCache(cacheKey, data);
          return data;
        })
        .finally(() => {
          if (this.cacheInflight.get(cacheKey) === request) this.cacheInflight.delete(cacheKey);
        });
      this.cacheInflight.set(cacheKey, request);
      return request;
    }

    // Non-GET: invalidate cached GET requests for this endpoint path
    const basePath = url.split("?")[0];
    for (const key of this.cache.keys()) {
      if (key.startsWith("req:") && key.includes(basePath.replace(/\/[^/]+$/, ""))) {
        this.cache.delete(key);
      }
    }
    return this.fetchRaw<T>(url, options);
  }

  protected async requestRouteContext<T>(endpoint: string): Promise<T> {
    const url = endpoint.startsWith(API_BASE) ? endpoint : `${API_BASE}${endpoint}`;
    return this.fetchRaw<T>(url, {}, { suppressGlobalStatus: true });
  }

  protected async requestBinary(
    endpoint: string,
    options: RequestInit = {},
    onProgress?: (progress: { loaded: number; total: number }) => void
  ): Promise<ArrayBuffer> {
    const url =
      endpoint.startsWith("/auth") || endpoint.startsWith(API_BASE)
        ? endpoint
        : `${API_BASE}${endpoint}`;
    const generation = this.sessionGeneration;
    const method = (options.method || "GET").toUpperCase();
    const headers = new Headers(this.getHeaders());
    if (options.headers) {
      new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    }
    if (options.body instanceof FormData) {
      headers.delete("Content-Type");
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers.set("X-CSRF-Token", await this.getCsrfToken());
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        credentials: "include",
        headers,
      });
    } catch {
      useAppStatusStore.getState().setMaintenanceActive(true);
      throw new ApiRequestError("Service unavailable", {
        status: 0,
        code: "SERVICE_UNAVAILABLE",
      });
    }

    if (response.status < 500) {
      useAppStatusStore.getState().setMaintenanceActive(false);
    }

    this.assertSessionGeneration(generation);

    if (!response.ok) {
      const parsedError = await response.json().catch(() => undefined);
      if (response.status === 429) {
        const retryAfterSeconds = getRetryAfterSeconds(response);
        useAppStatusStore.getState().activateRateLimit(retryAfterSeconds);
        throw new ApiRequestError("Too many requests, please try again later", {
          status: response.status,
          code: "RATE_LIMIT_EXCEEDED",
          retryAfterSeconds,
        });
      }
      if (response.status === 401) {
        this.clearCsrfToken();
        useAuthStore.getState().logout();
        window.location.href = getLoginRedirectUrl();
        throw new ApiRequestError("Session expired", {
          status: response.status,
          code: "UNAUTHORIZED",
        });
      }
      if (response.status === 403) {
        const message = extractApiErrorMessage(parsedError, "Insufficient permissions");
        if (message === "Invalid CSRF token") {
          this.clearCsrfToken();
        }
        if (message === "Account is blocked") {
          window.location.href = "/blocked";
          throw new ApiRequestError("Account is blocked", {
            status: response.status,
            code: "ACCOUNT_BLOCKED",
          });
        }
        throw new ApiRequestError(message, {
          status: response.status,
          code: "FORBIDDEN",
        });
      }

      const fallback = response.status >= 500 ? "Service unavailable" : "An unknown error occurred";
      throw new ApiRequestError(extractApiErrorMessage(parsedError, fallback), {
        status: response.status,
        code:
          parsedError && typeof parsedError === "object"
            ? ((parsedError as ApiError).code ?? undefined)
            : undefined,
      });
    }

    const contentLength = Number(response.headers.get("Content-Length"));
    const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
    onProgress?.({ loaded: 0, total });

    if (!response.body || !onProgress) {
      const data = await response.arrayBuffer();
      this.assertSessionGeneration(generation);
      onProgress?.({ loaded: data.byteLength, total });
      return data;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      loaded += next.value.byteLength;
      onProgress({ loaded, total });
    }

    const data = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.assertSessionGeneration(generation);
    return data.buffer;
  }

  protected async uploadRaw<T>(
    endpoint: string,
    {
      method = "POST",
      body,
      headers,
      onProgress,
    }: {
      method?: "POST" | "PUT";
      body: XMLHttpRequestBodyInit;
      headers?: HeadersInit;
      onProgress?: (progress: { loaded: number; total: number }) => void;
    }
  ): Promise<T> {
    const url =
      endpoint.startsWith("/auth") || endpoint.startsWith(API_BASE)
        ? endpoint
        : `${API_BASE}${endpoint}`;
    const generation = this.sessionGeneration;
    const requestHeaders = new Headers(headers);
    requestHeaders.set("X-CSRF-Token", await this.getCsrfToken());

    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.withCredentials = true;
      requestHeaders.forEach((value, key) => xhr.setRequestHeader(key, value));

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress?.({ loaded: event.loaded, total: event.total });
        }
      };

      xhr.onerror = () => {
        useAppStatusStore.getState().setMaintenanceActive(true);
        reject(
          new ApiRequestError("Service unavailable", {
            status: 0,
            code: "SERVICE_UNAVAILABLE",
          })
        );
      };

      xhr.onload = () => {
        if (xhr.status < 500) {
          useAppStatusStore.getState().setMaintenanceActive(false);
        }

        try {
          this.assertSessionGeneration(generation);
        } catch (err) {
          reject(err);
          return;
        }

        const parseJson = () => {
          if (!xhr.responseText) return undefined;
          try {
            return JSON.parse(xhr.responseText) as unknown;
          } catch {
            return undefined;
          }
        };

        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(parseJson() as T);
          return;
        }

        const parsedError = parseJson();
        const errorCode =
          parsedError && typeof parsedError === "object"
            ? ((parsedError as ApiError).code ?? undefined)
            : undefined;

        if (xhr.status === 429) {
          const retryAfterSeconds = getXhrRetryAfterSeconds(xhr);
          useAppStatusStore.getState().activateRateLimit(retryAfterSeconds);
          reject(
            new ApiRequestError("Too many requests, please try again later", {
              status: xhr.status,
              code: "RATE_LIMIT_EXCEEDED",
              retryAfterSeconds,
            })
          );
          return;
        }

        if (xhr.status === 401) {
          this.clearCsrfToken();
          useAuthStore.getState().logout();
          window.location.href = getLoginRedirectUrl();
          reject(
            new ApiRequestError("Session expired", {
              status: xhr.status,
              code: "UNAUTHORIZED",
            })
          );
          return;
        }

        if (xhr.status === 403) {
          const message = extractApiErrorMessage(parsedError, "Insufficient permissions");
          if (message === "Invalid CSRF token") {
            this.clearCsrfToken();
          }
          if (message === "Account is blocked") {
            window.location.href = "/blocked";
            reject(
              new ApiRequestError("Account is blocked", {
                status: xhr.status,
                code: "ACCOUNT_BLOCKED",
              })
            );
            return;
          }
          reject(
            new ApiRequestError(message, {
              status: xhr.status,
              code: "FORBIDDEN",
            })
          );
          return;
        }

        const fallback = xhr.status >= 500 ? "Service unavailable" : "An unknown error occurred";
        reject(
          new ApiRequestError(extractApiErrorMessage(parsedError, fallback), {
            status: xhr.status,
            code: errorCode,
          })
        );
      };

      xhr.send(body);
    });
  }

  /**
   * Unwrap a single-resource response wrapped in `{ data: ... }` by the backend.
   */
  protected unwrapData<T>(promise: Promise<{ data: T }>): Promise<T> {
    return promise.then((r) => r.data);
  }
}
