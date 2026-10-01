import type { Context, MiddlewareHandler } from 'hono';

const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

/** Whether the request carries no body, decided without reading it. */
function hasNoBody(c: Context): boolean {
  const headers = c.req.raw.headers;
  const length = headers.get('content-length');
  if (length !== null) return Number(length) === 0;
  if (headers.has('transfer-encoding')) return false;
  // An HTTP/1.1 request with neither header has no body; a Request built in process tells itself.
  const incoming = (c.env as { incoming?: { httpVersionMajor?: number } } | undefined)?.incoming;
  return incoming ? incoming.httpVersionMajor === 1 : c.req.raw.body === null;
}

/**
 * An empty body is no body. A client that sends `Content-Type: application/json` without
 * one made the JSON validator of a route with an optional body answer 400 "Malformed JSON";
 * without the content type it validates as no body, as when the header is left out.
 */
export const emptyJsonBodyMiddleware: MiddlewareHandler = async (c, next) => {
  const contentType = c.req.raw.headers.get('content-type');
  if (contentType && JSON_CONTENT_TYPE.test(contentType) && hasNoBody(c)) {
    c.req.raw.headers.delete('content-type');
  }
  await next();
};
