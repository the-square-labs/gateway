import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { DockerEnvironmentService } from './docker-environment.service.js';
import type { DockerSecretService } from './docker-secret.service.js';

type DockerDispatchResult = { success: boolean; error?: string; detail?: string };

export interface DockerEnvOperationContext {
  nodeDispatch: NodeDispatchService;
  environmentService?: DockerEnvironmentService;
  secretService?: DockerSecretService;
  parseResult(result: DockerDispatchResult): any;
}

export async function getContainerEnv(context: DockerEnvOperationContext, nodeId: string, containerId: string) {
  const result = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
  const inspect = context.parseResult(result);
  const allEnv: string[] = inspect?.Config?.Env || [];
  const name = (inspect?.Name ?? '').replace(/^\//, '');

  let visibleEnv = allEnv;
  let secretKeys = new Set<string>();
  if (context.secretService && name) {
    secretKeys = await context.secretService.getSecretKeys(nodeId, name);
    if (secretKeys.size > 0) {
      visibleEnv = allEnv.filter((entry) => {
        const key = entry.split('=')[0];
        return !secretKeys.has(key);
      });
    }
  }

  if (context.environmentService && name) {
    const storedEnv = await context.environmentService.getDecryptedMap(nodeId, name);
    if (Object.keys(storedEnv).length > 0) {
      return envMapToList(Object.fromEntries(Object.entries(storedEnv).filter(([key]) => !secretKeys.has(key))));
    }

    await context.environmentService.seedFromRuntimeIfMissing(nodeId, name, envListToMap(visibleEnv));
  }

  return visibleEnv;
}

export function normalizeEnvRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key.trim().length > 0)
      .map(([key, entryValue]) => [key, String(entryValue ?? '')])
  );
}

export function envListToMap(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const idx = entry.indexOf('=');
    if (idx === -1) {
      env[entry] = '';
    } else {
      env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
  }
  return env;
}

export function envMapToList(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}
