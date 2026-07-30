import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { container } from '@/container.js';
import type { AppEnv } from '@/types.js';
import { mcpAuthMiddleware } from './mcp-auth.middleware.js';
import { createMcpServer } from './mcp-server.factory.js';
import { McpSettingsService } from './mcp-settings.service.js';

export const mcpRoutes = new Hono<AppEnv>();
const MCP_ROUTE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const issuedMcpSessions = new Map<string, number>();

function mcpSessionIdFromRequest(request: Request): string | undefined {
  const value = request.headers.get('mcp-session-id')?.trim();
  return value || undefined;
}

function mcpRouteAuthKey(auth: { tokenId: string; tokenPrefix: string; authType?: string; clientId?: string }): string {
  return [auth.authType ?? 'unknown', auth.tokenId || auth.tokenPrefix || 'token', auth.clientId ?? 'client'].join(':');
}

function mcpRouteSessionKey(authKey: string, sessionId: string): string {
  return `${authKey}:session:${sessionId}`;
}

function cleanupIssuedMcpSessions(now = Date.now()): void {
  for (const [key, lastAccessAt] of issuedMcpSessions) {
    if (now - lastAccessAt > MCP_ROUTE_SESSION_TTL_MS) {
      issuedMcpSessions.delete(key);
    }
  }
}

function acceptedMcpSessionId(authKey: string, request: Request): string | undefined {
  cleanupIssuedMcpSessions();
  const sessionId = mcpSessionIdFromRequest(request);
  if (!sessionId) return undefined;
  const key = mcpRouteSessionKey(authKey, sessionId);
  if (!issuedMcpSessions.has(key)) return undefined;
  issuedMcpSessions.set(key, Date.now());
  return sessionId;
}

function rememberIssuedMcpSession(authKey: string, sessionId: string): void {
  issuedMcpSessions.set(mcpRouteSessionKey(authKey, sessionId), Date.now());
}

function withMcpSessionHeader(response: Response, sessionId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('mcp-session-id', sessionId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function methodNotAllowed() {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32601,
        message: 'Method not allowed for stateless MCP; use POST',
      },
    }),
    {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

mcpRoutes.use('*', async (c, next) => {
  const config = await container.resolve(McpSettingsService).getConfig();
  if (!config.serverEnabled) {
    throw new HTTPException(404, { message: 'MCP server is disabled' });
  }
  c.set('mcpExtendedCompatibility', config.extendedCompatibility);
  await next();
});

mcpRoutes.use('*', mcpAuthMiddleware);

mcpRoutes.post('/', async (c) => {
  const user = c.get('user');
  const scopes = c.get('effectiveScopes');
  const auth = c.get('mcpAuth');
  if (!user || !scopes || !auth) {
    return c.json({ message: 'MCP authentication context missing' }, 500);
  }

  const authKey = mcpRouteAuthKey(auth);
  const requestedMcpSessionId = mcpSessionIdFromRequest(c.req.raw);
  const incomingMcpSessionId = acceptedMcpSessionId(authKey, c.req.raw);
  const responseMcpSessionId = incomingMcpSessionId ?? randomUUID();
  const handlerMcpSessionId = incomingMcpSessionId ?? (requestedMcpSessionId ? responseMcpSessionId : undefined);
  rememberIssuedMcpSession(authKey, responseMcpSessionId);
  const { server, transport } = createMcpServer({
    user,
    scopes,
    tokenId: auth.tokenId,
    tokenPrefix: auth.tokenPrefix,
    mcpSessionId: handlerMcpSessionId,
    issuedMcpSessionId: responseMcpSessionId,
    authType: auth.authType,
    clientId: auth.clientId,
    eagerToolListing: c.get('mcpExtendedCompatibility') ?? false,
  });

  await server.connect(transport);
  return withMcpSessionHeader(await transport.handleRequest(c.req.raw), responseMcpSessionId);
});

mcpRoutes.get('/', () => methodNotAllowed());
mcpRoutes.delete('/', () => methodNotAllowed());
