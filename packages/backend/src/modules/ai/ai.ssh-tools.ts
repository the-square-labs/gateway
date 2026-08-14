import { container } from '@/container.js';
import { ExternalSshService } from '@/modules/integrations/external-ssh.service.js';
import type { User } from '@/types.js';
import { inspectConsoleCommand } from './ai.console-safety.js';

export const SSH_TOOL_NAMES = new Set(['ssh_list_connectors', 'ssh_execute_command', 'create_ssh_connector']);

export async function executeSshTool(user: User, toolName: string, args: Record<string, unknown>) {
  const service = container.resolve(ExternalSshService);
  if (toolName === 'ssh_list_connectors') return service.list(user);
  if (toolName === 'ssh_execute_command') {
    const connectorId = typeof args.connectorId === 'string' ? args.connectorId : '';
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!connectorId || !command) throw new Error('connectorId and command are required');
    const safety = inspectConsoleCommand(['sh', '-lc', command]);
    if (safety.blocked) throw new Error(safety.reason);
    return service.execute(user, connectorId, command);
  }
  if (toolName === 'create_ssh_connector') {
    return service.create(user, {
      name: requiredString(args.name),
      host: requiredString(args.host),
      port: typeof args.port === 'number' ? args.port : undefined,
      username: requiredString(args.username),
      authMethod: args.authMethod === 'password' ? 'password' : 'private_key',
      secret: requiredString(args.secret),
      passphrase: optionalString(args.passphrase),
      hostFingerprint: requiredString(args.hostFingerprint),
      jumpConnectorId: optionalString(args.jumpConnectorId),
      enabled: true,
    });
  }
  throw new Error(`Unsupported SSH tool: ${toolName}`);
}

function requiredString(value: unknown): string {
  const text = optionalString(value);
  if (!text) throw new Error('Required value is missing');
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
