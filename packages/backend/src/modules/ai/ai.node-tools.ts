import { hasScopeForResource } from '@/lib/permissions.js';
import {
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadChunkQuerySchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
} from '@/modules/docker/docker.schemas.js';
import { UpdateNodeServiceCreationLockSchema } from '@/modules/nodes/nodes.schemas.js';
import type { NodesService } from '@/modules/nodes/nodes.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { User } from '@/types.js';
import { inspectConsoleCommand, parseConsoleCommandResult } from './ai.console-safety.js';
import { agentPage, agentPageLimit, allowedResourceIdsForScopes } from './ai.service-helpers.js';

export const NODE_TOOL_NAMES = new Set([
  'list_nodes',
  'get_node',
  'execute_node_console_command',
  'create_node',
  'rename_node',
  'set_node_service_creation_lock',
  'delete_node',
  'manage_node_config',
  'manage_node_file',
]);

const NODE_FILE_LIST_MAX = 1000;
const NODE_FILE_READ_LIMIT_BYTES = 256 * 1024;

export interface NodeToolContext {
  nodesService: NodesService;
  getDispatchService?: () => NodeDispatchService;
}

export async function executeNodeTool(
  context: NodeToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  switch (toolName) {
    case 'list_nodes': {
      const result = await context.nodesService.list(
        {
          search: a.search,
          type: a.type,
          status: a.status,
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
        },
        { allowedIds: allowedResourceIdsForScopes(user.scopes, 'nodes:details') }
      );
      return {
        ...result,
        data: result.data.map((node) => ({
          id: node.id,
          type: node.type,
          hostname: node.hostname,
          displayName: node.displayName,
          appearanceColor: node.appearanceColor,
          status: node.status,
          isConnected: node.isConnected,
          serviceCreationLocked: node.serviceCreationLocked,
          daemonVersion: node.daemonVersion,
          osInfo: node.osInfo,
          configVersionHash: node.configVersionHash,
          capabilities: node.capabilities,
          lastSeenAt: node.lastSeenAt,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
        })),
      };
    }
    case 'get_node':
      return context.nodesService.get(a.nodeId);
    case 'execute_node_console_command':
      return executeNodeConsoleCommand(context, user, a);
    case 'create_node':
      return context.nodesService.create(
        { hostname: a.hostname, type: a.type || 'nginx', displayName: a.displayName },
        user.id
      );
    case 'rename_node':
      return context.nodesService.update(a.nodeId, { displayName: a.displayName }, user.id);
    case 'set_node_service_creation_lock': {
      // Mirrors PATCH /nodes/{id}/service-creation-lock.
      if (!hasScopeForResource(user.scopes, 'nodes:lock', String(a.nodeId ?? ''))) {
        throw new Error(`PERMISSION_DENIED: Missing required scope nodes:lock:${String(a.nodeId ?? '')}`);
      }
      const input = UpdateNodeServiceCreationLockSchema.parse({ serviceCreationLocked: a.serviceCreationLocked });
      return context.nodesService.updateServiceCreationLock(a.nodeId, input, user.id);
    }
    case 'delete_node':
      await context.nodesService.remove(a.nodeId, user.id);
      return { success: true };
    case 'manage_node_config':
      return executeNodeConfigTool(context, user, a);
    case 'manage_node_file':
      return executeNodeFileTool(context.nodesService, user, a);
    default:
      throw new Error(`Unsupported node tool: ${toolName}`);
  }
}

async function executeNodeConsoleCommand(context: NodeToolContext, user: User, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId || '');
  if (!nodeId) throw new Error('nodeId is required');
  assertNodeConsoleScope(user, nodeId);

  const safety = inspectConsoleCommand(args.command as string[]);
  if (safety.blocked) {
    throw new Error(safety.reason ?? 'Console command is blocked');
  }

  const result = await getRequiredDispatchService(context).sendNodeExecCommand(
    nodeId,
    'run',
    { command: safety.normalizedCommand },
    35000
  );
  if (!result.success) {
    throw new Error(result.error || 'Node console command failed');
  }
  const output = parseConsoleCommandResult(result.detail);
  return {
    nodeId,
    command: safety.normalizedCommand,
    risky: safety.risky,
    ...output,
  };
}

async function executeNodeConfigTool(context: NodeToolContext, user: User, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId || '');
  const operation = String(args.operation || '');
  if (!nodeId) throw new Error('nodeId is required');
  if (!operation) throw new Error('operation is required');

  const dispatchService = getRequiredDispatchService(context);

  switch (operation) {
    case 'read': {
      assertNodeConfigScope(user, 'nodes:config:view', nodeId);
      const result = await dispatchService.readGlobalConfig(nodeId);
      if (!result.success) throw new Error(result.error || 'Failed to read node config');
      return { nodeId, content: result.detail ?? '' };
    }
    case 'update': {
      assertNodeConfigScope(user, 'nodes:config:edit', nodeId);
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content) throw new Error('content is required');
      if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) {
        throw new Error('Config content is too large. Maximum size is 1 MB.');
      }
      const result = await dispatchService.updateGlobalConfig(nodeId, content, '');
      return { nodeId, valid: result.success, error: result.success ? null : result.error };
    }
    case 'test': {
      assertNodeConfigScope(user, 'nodes:config:edit', nodeId);
      const result = await dispatchService.testConfig(nodeId);
      return {
        nodeId,
        valid: result.success,
        output: result.detail ?? null,
        error: result.success ? null : result.error,
      };
    }
    default:
      throw new Error(`Unsupported node config operation: ${operation}`);
  }
}

function getRequiredDispatchService(context: NodeToolContext): NodeDispatchService {
  if (!context.getDispatchService) {
    throw new Error('Node dispatch service is not available');
  }
  return context.getDispatchService();
}

async function executeNodeFileTool(nodesService: NodesService, user: User, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId || '');
  const operation = String(args.operation || '');
  if (!nodeId) throw new Error('nodeId is required');
  if (!operation) throw new Error('operation is required');

  switch (operation) {
    case 'list': {
      assertNodeFileScope(user, 'nodes:files:read', nodeId);
      const { path } = FileBrowseSchema.parse({ path: args.path });
      const data = await nodesService.listFiles(nodeId, path);
      const files = Array.isArray(data) ? data : [];
      const truncated = files.length > NODE_FILE_LIST_MAX;
      return {
        data: truncated ? files.slice(0, NODE_FILE_LIST_MAX) : files,
        total: files.length,
        limit: NODE_FILE_LIST_MAX,
        truncated,
      };
    }
    case 'read': {
      assertNodeFileScope(user, 'nodes:files:read', nodeId);
      const { path } = FileBrowseSchema.parse({ path: args.path });
      const data = await nodesService.readFile(nodeId, path);
      return compactNodeFileRead(data, args.encoding, args.limitBytes);
    }
    case 'write': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const { path } = FileBrowseSchema.parse({ path: args.path });
      await nodesService.writeFile(nodeId, path, decodeNodeFileContent(args), user.id);
      return { success: true };
    }
    case 'create': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const { path } = FileBrowseSchema.parse({ path: args.path });
      await nodesService.createFile(nodeId, path, decodeOptionalNodeFileContent(args), user.id);
      return { success: true };
    }
    case 'mkdir': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const { path } = FileBrowseSchema.parse({ path: args.path });
      await nodesService.createDirectory(nodeId, path, user.id);
      return { success: true };
    }
    case 'delete': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const { path } = FileBrowseSchema.parse({ path: args.path });
      await nodesService.deleteFile(nodeId, path, user.id);
      return { success: true };
    }
    case 'move': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const { fromPath, toPath } = FileMoveSchema.parse({ fromPath: args.fromPath, toPath: args.toPath });
      await nodesService.moveFile(nodeId, fromPath, toPath, user.id);
      return { success: true };
    }
    case 'upload_init': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const { path, totalBytes } = FileUploadInitSchema.parse({ path: args.path, totalBytes: args.totalBytes });
      return nodesService.initFileUpload(nodeId, path, totalBytes, user.id);
    }
    case 'upload_chunk': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const uploadId = String(args.uploadId || '');
      if (!uploadId) throw new Error('uploadId is required');
      const { offset } = FileUploadChunkQuerySchema.parse({ offset: args.offset });
      const data = await nodesService.appendFileUploadChunk(nodeId, uploadId, offset, decodeNodeFileBuffer(args));
      return { data };
    }
    case 'upload_complete': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const uploadId = String(args.uploadId || '');
      if (!uploadId) throw new Error('uploadId is required');
      const { path, totalBytes } = FileUploadCompleteSchema.parse({ path: args.path, totalBytes: args.totalBytes });
      await nodesService.completeFileUpload(nodeId, uploadId, path, totalBytes);
      return { success: true };
    }
    case 'upload_abort': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const uploadId = String(args.uploadId || '');
      if (!uploadId) throw new Error('uploadId is required');
      await nodesService.abortFileUpload(nodeId, uploadId);
      return { success: true };
    }
    default:
      throw new Error(`Unsupported node file operation: ${operation}`);
  }
}

function assertNodeConfigScope(user: User, scope: 'nodes:config:view' | 'nodes:config:edit', nodeId: string) {
  if (!hasScopeForResource(user.scopes, scope, nodeId)) {
    throw new Error(`Missing required scope: ${scope}:${nodeId}`);
  }
}

function assertNodeFileScope(user: User, scope: 'nodes:files:read' | 'nodes:files:write', nodeId: string) {
  if (!hasScopeForResource(user.scopes, scope, nodeId)) {
    throw new Error(`Missing required scope: ${scope}:${nodeId}`);
  }
}

function assertNodeConsoleScope(user: User, nodeId: string) {
  if (!hasScopeForResource(user.scopes, 'nodes:console', nodeId)) {
    throw new Error(`Missing required scope: nodes:console:${nodeId}`);
  }
}

function decodeOptionalNodeFileContent(args: Record<string, unknown>): string | Buffer | undefined {
  if (typeof args.contentBase64 === 'string') return Buffer.from(args.contentBase64, 'base64');
  if (typeof args.content === 'string') return args.content;
  return undefined;
}

function decodeNodeFileContent(args: Record<string, unknown>): string | Buffer {
  const content = decodeOptionalNodeFileContent(args);
  if (content === undefined) throw new Error('content or contentBase64 is required');
  return content;
}

function decodeNodeFileBuffer(args: Record<string, unknown>): Buffer {
  const content = decodeNodeFileContent(args);
  return Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
}

function compactNodeFileRead(data: Buffer | Uint8Array, encoding: unknown, limitBytes: unknown) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const requestedLimit = typeof limitBytes === 'number' && Number.isFinite(limitBytes) ? Math.floor(limitBytes) : 0;
  const limit = requestedLimit > 0 ? Math.min(requestedLimit, NODE_FILE_READ_LIMIT_BYTES) : NODE_FILE_READ_LIMIT_BYTES;
  const slice = buffer.subarray(0, limit);
  const forcedEncoding = encoding === 'utf8' || encoding === 'base64' ? encoding : 'auto';
  const outputEncoding = forcedEncoding === 'auto' ? detectNodeFileEncoding(slice) : forcedEncoding;

  return {
    encoding: outputEncoding,
    content: outputEncoding === 'base64' ? slice.toString('base64') : slice.toString('utf8'),
    sizeBytes: buffer.byteLength,
    returnedBytes: slice.byteLength,
    truncated: buffer.byteLength > slice.byteLength,
  };
}

function detectNodeFileEncoding(buffer: Buffer): 'utf8' | 'base64' {
  if (buffer.includes(0)) return 'base64';
  const text = buffer.toString('utf8');
  const replacementCount = (text.match(/\uFFFD/g) ?? []).length;
  return replacementCount > Math.max(2, text.length * 0.02) ? 'base64' : 'utf8';
}
