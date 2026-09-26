import {
  beginIdempotentOperation,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_STORED_RESPONSE_MAX_BYTES,
  idempotencyFingerprint,
  isValidIdempotencyKey,
} from '@/middleware/idempotency.js';
import type { AIToolDefinition, ToolExecutionResult } from '@/modules/ai/ai.types.js';
import type { McpAuthContext } from './mcp-types.js';

export const MCP_IDEMPOTENCY_KEY_ARGUMENT = 'idempotencyKey';

interface McpIdempotentToolRule {
  /** Argument naming the operation; omitted for single-purpose create tools. */
  operationField?: 'operation' | 'action';
  /** Operations that create a resource and honor the key. */
  operations?: readonly string[];
}

/**
 * Create-type MCP tools that accept an `idempotencyKey` argument. The key maps onto the same
 * Redis-backed mechanism as the REST `Idempotency-Key` header, scoped to the MCP token and tool.
 * Tools that mint secrets (API/inference/Pages tokens, access keys, PKI private keys) are left out
 * so their plaintext secrets are never stored for replay.
 */
export const MCP_IDEMPOTENT_CREATE_TOOLS: Readonly<Record<string, McpIdempotentToolRule>> = {
  create_docker_container: {},
  duplicate_docker_container: {},
  manage_docker_deployment: { operationField: 'operation', operations: ['create'] },
  manage_docker_compose: { operationField: 'operation', operations: ['create'] },
  manage_docker_source: { operationField: 'operation', operations: ['create'] },
  manage_docker_volume: { operationField: 'operation', operations: ['create'] },
  manage_docker_network: { operationField: 'operation', operations: ['create'] },
  manage_docker_registry: { operationField: 'operation', operations: ['create'] },
  create_route: {},
  create_route_folder: {},
  create_domain: {},
  create_access_list: {},
  request_acme_cert: {},
  manage_ssl_certificate: { operationField: 'operation', operations: ['upload'] },
  create_root_ca: {},
  create_intermediate_ca: {},
  manage_database_connection: { operationField: 'operation', operations: ['create'] },
  manage_managed_database: { operationField: 'operation', operations: ['create', 'create_binding'] },
  manage_storage_connection: { operationField: 'action', operations: ['create'] },
  manage_managed_storage: { operationField: 'action', operations: ['create', 'create_binding'] },
  manage_pages: { operationField: 'operation', operations: ['project_create'] },
  create_node: {},
  create_webhook: {},
  create_alert_rule: {},
  create_siem_destination: {},
};

type JsonSchemaObject = {
  type: 'object';
  properties?: Record<string, object>;
  required?: string[];
  [key: string]: unknown;
};

function declaresIdempotencyKey(tool: Pick<AIToolDefinition, 'parameters'>): boolean {
  const properties = (tool.parameters as JsonSchemaObject).properties;
  return !!properties && Object.hasOwn(properties, MCP_IDEMPOTENCY_KEY_ARGUMENT);
}

function operationsText(rule: McpIdempotentToolRule): string {
  if (!rule.operations?.length || !rule.operationField) return '';
  const list = rule.operations.map((operation) => `"${operation}"`).join(' or ');
  return ` with ${rule.operationField} ${list}`;
}

function idempotencyDescription(rule: McpIdempotentToolRule): string {
  return `Retry-safe${operationsText(rule)}: pass idempotencyKey (1-${IDEMPOTENCY_KEY_MAX_LENGTH} printable characters, e.g. a UUID). Retrying with the same key and arguments within 24 hours returns the original result instead of creating a duplicate; other arguments under the same key fail with IDEMPOTENCY_KEY_REUSED, and a retry while the first call still runs fails with IDEMPOTENCY_KEY_IN_PROGRESS.`;
}

/** Description and input schema advertised through MCP, with the idempotencyKey argument when supported. */
export function mcpToolListing(tool: AIToolDefinition): { description: string; inputSchema: JsonSchemaObject } {
  const inputSchema = tool.parameters as JsonSchemaObject;
  const rule = MCP_IDEMPOTENT_CREATE_TOOLS[tool.name];
  if (!rule) return { description: tool.description, inputSchema };
  const propertyDescription = idempotencyDescription(rule);
  return {
    description: `${tool.description} ${propertyDescription}`,
    inputSchema: {
      ...inputSchema,
      properties: {
        ...(inputSchema.properties ?? {}),
        [MCP_IDEMPOTENCY_KEY_ARGUMENT]: {
          ...((inputSchema.properties?.[MCP_IDEMPOTENCY_KEY_ARGUMENT] as object | undefined) ?? {}),
          type: 'string',
          ...(declaresIdempotencyKey(tool) ? {} : { minLength: 1, maxLength: IDEMPOTENCY_KEY_MAX_LENGTH }),
          description: declaresIdempotencyKey(tool)
            ? `${propertyDescription} Other operations keep their own use of this key.`
            : propertyDescription,
        },
      },
    },
  };
}

export type McpIdempotencyExtraction =
  | { ok: true; args: Record<string, unknown>; key?: string }
  | { ok: false; error: string };

/**
 * Split the MCP-level idempotency key off the tool arguments. Tools whose own schema declares
 * `idempotencyKey` (Compose lifecycle operations) keep it in their arguments.
 */
export function extractMcpIdempotencyKey(
  tool: Pick<AIToolDefinition, 'name' | 'parameters'>,
  args: Record<string, unknown>
): McpIdempotencyExtraction {
  const rule = MCP_IDEMPOTENT_CREATE_TOOLS[tool.name];
  if (!rule || !Object.hasOwn(args, MCP_IDEMPOTENCY_KEY_ARGUMENT)) return { ok: true, args };

  const value = args[MCP_IDEMPOTENCY_KEY_ARGUMENT];
  const toolArgs = declaresIdempotencyKey(tool)
    ? args
    : Object.fromEntries(Object.entries(args).filter(([name]) => name !== MCP_IDEMPOTENCY_KEY_ARGUMENT));
  const operation = rule.operationField ? args[rule.operationField] : undefined;
  const createsResource = !rule.operations || (typeof operation === 'string' && rule.operations.includes(operation));
  if (!createsResource || value === undefined || value === null) return { ok: true, args: toolArgs };
  if (!isValidIdempotencyKey(value)) {
    return {
      ok: false,
      error: `IDEMPOTENCY_KEY_INVALID: idempotencyKey must be 1-${IDEMPOTENCY_KEY_MAX_LENGTH} printable ASCII characters.`,
    };
  }
  return { ok: true, args: toolArgs, key: value };
}

interface StoredMcpToolResult {
  result: unknown;
}

export type McpIdempotentOutcome =
  | { kind: 'executed'; execution: ToolExecutionResult }
  | { kind: 'replayed'; result: unknown }
  | { kind: 'rejected'; error: string };

/**
 * Run a create tool once per (MCP token, tool, idempotencyKey). Successful results are stored for
 * 24 hours and replayed; a failed call releases the key so a retry runs again.
 */
export async function runMcpToolIdempotently(
  input: { auth: McpAuthContext; toolName: string; key: string; args: Record<string, unknown> },
  execute: () => Promise<ToolExecutionResult>
): Promise<McpIdempotentOutcome> {
  const { [MCP_IDEMPOTENCY_KEY_ARGUMENT]: _key, ...fingerprintArgs } = input.args;
  const principal = `mcp-${input.auth.authType ?? 'token'}:${input.auth.tokenId || input.auth.tokenPrefix}`;
  const begin = await beginIdempotentOperation<StoredMcpToolResult>(
    { principal, method: 'MCP', path: `tools/${input.toolName}`, key: input.key },
    idempotencyFingerprint({ arguments: fingerprintArgs })
  );

  switch (begin.kind) {
    case 'unavailable':
      return { kind: 'executed', execution: await execute() };
    case 'mismatch':
      return {
        kind: 'rejected',
        error:
          'IDEMPOTENCY_KEY_REUSED: this idempotencyKey was already used with different arguments for this tool. Use a new key for a new request.',
      };
    case 'in_progress':
      return {
        kind: 'rejected',
        error: `IDEMPOTENCY_KEY_IN_PROGRESS: a call with this idempotencyKey is still running. Retry the same call in ${begin.retryAfterSeconds} seconds to get its result.`,
      };
    case 'replay':
      return { kind: 'replayed', result: begin.payload.result };
    case 'proceed': {
      let execution: ToolExecutionResult;
      try {
        execution = await execute();
      } catch (error) {
        await begin.lease.release();
        throw error;
      }
      const stored: StoredMcpToolResult = { result: execution.result ?? null };
      if (
        execution.error ||
        execution.credentialChallenge ||
        storedSize(stored) > IDEMPOTENCY_STORED_RESPONSE_MAX_BYTES
      ) {
        await begin.lease.release();
      } else {
        await begin.lease.complete(stored);
      }
      return { kind: 'executed', execution };
    }
  }
}

function storedSize(value: StoredMcpToolResult): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
