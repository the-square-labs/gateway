/**
 * Replaces `fetch` with a stub that answers every request with an empty list
 * (or the given body) and records "METHOD path" for each call, so tests can
 * count the requests a screen makes.
 */
export function stubRequestLog(bodies: Array<[RegExp, unknown]> = []) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
      const body = bodies.find(([pattern]) => pattern.test(url))?.[1] ?? {
        data: [],
        pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return {
    requests,
    count: (request: string) => requests.filter((entry) => entry === request).length,
  };
}
