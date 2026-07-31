import { z } from 'zod';
import { container } from '@/container.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import {
  DockerHealthCheckUpsertSchema,
  EnvUpdateSchema,
  FileBrowseSchema,
  SecretCreateSchema,
  SecretUpdateSchema,
} from '@/modules/docker/docker.schemas.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import { dockerScopedNodeIds } from '@/modules/docker/docker-access-resource.service.js';
import type { User } from '@/types.js';

const FileWriteToolSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export interface DockerConfigToolContext {
  dockerService: DockerManagementService;
}

export async function manageDockerContainerConfigTool(
  context: DockerConfigToolContext,
  user: User,
  args: Record<string, unknown>
) {
  const operation = String(args.operation);
  const nodeId = String(args.nodeId);
  const targetType = args.targetType === 'deployment' ? 'deployment' : 'container';
  const deploymentId = String(args.deploymentId ?? '');
  const containerName = String(args.containerName ?? '');
  const containerId = String(args.containerId ?? '');
  const secretContainerName = targetType === 'deployment' ? `deployment:${deploymentId}` : containerName;
  const authorizationResourceId = async (baseScope: string) => {
    if (targetType === 'deployment') return `${nodeId}/${deploymentId}`;
    if (hasScopeForResource(user.scopes, baseScope, nodeId)) return nodeId;
    if (!dockerScopedNodeIds(user.scopes, [baseScope]).includes(nodeId)) return nodeId;
    const inspected = await context.dockerService.inspectContainer(nodeId, containerId || containerName);
    const resourceId = String(inspected?.scopeResourceId ?? '');
    if (!resourceId) throw new Error('PERMISSION_DENIED: Container authorization identity is unavailable');
    return `${nodeId}/${resourceId}`;
  };

  if (operation === 'get_env') {
    ensureToolScopeForResource(
      user,
      'docker:containers:environment',
      await authorizationResourceId('docker:containers:environment')
    );
    return context.dockerService.getContainerEnv(nodeId, containerId);
  }
  if (operation === 'update_env') {
    ensureToolScopeForResource(
      user,
      'docker:containers:environment',
      await authorizationResourceId('docker:containers:environment')
    );
    const input = EnvUpdateSchema.parse(args);
    return context.dockerService.updateContainerEnv(nodeId, containerId, input.env, input.removeEnv, user.id);
  }
  if (operation === 'list_files') {
    ensureToolScopeForResource(
      user,
      'docker:containers:files',
      await authorizationResourceId('docker:containers:files')
    );
    const input = FileBrowseSchema.parse(args);
    return context.dockerService.listDirectory(nodeId, containerId, input.path);
  }
  if (operation === 'read_file') {
    ensureToolScopeForResource(
      user,
      'docker:containers:files',
      await authorizationResourceId('docker:containers:files')
    );
    const input = FileBrowseSchema.parse(args);
    const content = await context.dockerService.readFile(nodeId, containerId, input.path);
    return { path: input.path, content: Buffer.from(content).toString('utf-8') };
  }
  if (operation === 'write_file') {
    ensureToolScopeForResource(
      user,
      'docker:containers:files',
      await authorizationResourceId('docker:containers:files')
    );
    const input = FileWriteToolSchema.parse(args);
    await context.dockerService.writeFile(nodeId, containerId, input.path, input.content, user.id);
    return { success: true };
  }
  if (operation.endsWith('_secret') || operation === 'list_secrets') {
    ensureToolScopeForResource(
      user,
      'docker:containers:secrets',
      await authorizationResourceId('docker:containers:secrets')
    );
    const { DockerSecretService } = await import('@/modules/docker/docker-secret.service.js');
    const secretService = container.resolve(DockerSecretService);
    if (targetType === 'deployment') {
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      await container.resolve(DockerDeploymentService).get(nodeId, deploymentId);
    }
    if (operation === 'list_secrets') {
      return secretService.list(nodeId, secretContainerName, Boolean(args.reveal));
    }
    if (operation === 'create_secret') {
      const input = SecretCreateSchema.parse(args);
      return secretService.create(nodeId, secretContainerName, input.key, input.value, user.id);
    }
    if (operation === 'update_secret') {
      const input = SecretUpdateSchema.parse(args);
      return secretService.update(String(args.secretId), nodeId, input.value, user.id, secretContainerName);
    }
    if (operation === 'delete_secret') {
      await secretService.delete(String(args.secretId), nodeId, user.id, secretContainerName);
      return { success: true };
    }
  }
  if (operation.includes('webhook')) {
    ensureToolScopeForResource(
      user,
      'docker:containers:webhooks',
      await authorizationResourceId('docker:containers:webhooks')
    );
    if (targetType === 'deployment') {
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const deploymentService = container.resolve(DockerDeploymentService);
      if (operation === 'get_webhook') return deploymentService.getWebhook(nodeId, deploymentId);
      if (operation === 'upsert_webhook') {
        return deploymentService.upsertWebhook(
          nodeId,
          deploymentId,
          { enabled: args.enabled as boolean | undefined },
          user.id
        );
      }
      if (operation === 'delete_webhook') {
        await deploymentService.deleteWebhook(nodeId, deploymentId, user.id);
        return { success: true };
      }
      if (operation === 'regenerate_webhook_token') {
        return deploymentService.regenerateWebhook(nodeId, deploymentId, user.id);
      }
    }
    const { DockerWebhookService } = await import('@/modules/docker/docker-webhook.service.js');
    const webhookService = container.resolve(DockerWebhookService);
    if (operation === 'get_webhook') return webhookService.getByContainer(nodeId, containerName);
    if (operation === 'upsert_webhook') {
      return webhookService.upsert(nodeId, containerName, { enabled: args.enabled as boolean | undefined }, user.id);
    }
    if (operation === 'delete_webhook') {
      await webhookService.remove(nodeId, containerName, user.id);
      return { success: true };
    }
    if (operation === 'regenerate_webhook_token') {
      return webhookService.regenerateToken(nodeId, containerName, user.id);
    }
  }
  if (operation.includes('health_check')) {
    const readOnly = operation === 'get_health_check';
    ensureToolScopeForResource(
      user,
      readOnly ? 'docker:containers:view' : 'docker:containers:edit',
      await authorizationResourceId(readOnly ? 'docker:containers:view' : 'docker:containers:edit')
    );
    const { DockerHealthCheckService } = await import('@/modules/docker/docker-health-check.service.js');
    const healthService = container.resolve(DockerHealthCheckService);
    const input =
      args.healthCheck && typeof args.healthCheck === 'object'
        ? DockerHealthCheckUpsertSchema.parse(args.healthCheck)
        : undefined;
    if (targetType === 'deployment') {
      if (operation === 'get_health_check') return healthService.getDeployment(nodeId, deploymentId);
      if (operation === 'upsert_health_check') {
        return healthService.upsertDeployment(
          nodeId,
          deploymentId,
          DockerHealthCheckUpsertSchema.parse(args.healthCheck ?? {})
        );
      }
      if (operation === 'test_health_check') return healthService.testDeployment(nodeId, deploymentId, input);
    }
    if (operation === 'get_health_check') return healthService.getContainer(nodeId, containerName);
    if (operation === 'upsert_health_check') {
      return healthService.upsertContainer(
        nodeId,
        containerName,
        DockerHealthCheckUpsertSchema.parse(args.healthCheck ?? {})
      );
    }
    if (operation === 'test_health_check') return healthService.testContainer(nodeId, containerName, input);
  }

  throw new Error(`Unsupported Docker container config operation: ${operation}`);
}

function ensureToolScopeForResource(user: User, baseScope: string, resourceId: string) {
  if (!hasScopeForResource(user.scopes, baseScope, resourceId)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${baseScope}:${resourceId}`);
  }
}
