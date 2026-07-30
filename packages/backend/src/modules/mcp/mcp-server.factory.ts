import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { User } from '@/types.js';
import { registerMcpPrompts } from './mcp-prompts.js';
import { registerMcpResources } from './mcp-resources.js';
import { registerMcpToolHandlers } from './mcp-tools.js';

export interface CreateMcpServerOptions {
  user: User;
  scopes: string[];
  tokenId: string;
  tokenPrefix: string;
  mcpSessionId?: string;
  issuedMcpSessionId?: string;
  authType?: 'oauth' | 'api-token';
  clientId?: string;
  eagerToolListing?: boolean;
}

export function createMcpServer(options: CreateMcpServerOptions) {
  const server = new McpServer(
    { name: 'gateway', version: '1.0.0' },
    {
      instructions:
        'Gateway MCP exposes scoped control-plane tools, curated read-only resources, and operational prompts. OAuth token scopes determine every listed and callable capability.',
    }
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: false,
  });

  registerMcpToolHandlers(
    server,
    {
      server,
      scopes: options.scopes,
      tokenId: options.tokenId,
      tokenPrefix: options.tokenPrefix,
      mcpSessionId: options.mcpSessionId,
      issuedMcpSessionId: options.issuedMcpSessionId,
      authType: options.authType,
      clientId: options.clientId,
      eagerToolListing: options.eagerToolListing,
    },
    options.user
  );
  registerMcpResources(server, options.scopes);
  registerMcpPrompts(server, options.scopes);

  return { server, transport };
}
