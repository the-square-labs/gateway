import { container } from '@/container.js';
import { hasScope } from '@/lib/permissions.js';
import { InferenceUsageService } from '@/modules/inference/accounting/inference-usage.service.js';
import {
  CreateInferenceProviderConnectionSchema,
  CreateInferenceTokenSchema,
  InferenceLimitPolicyInputSchema,
  InferenceModelConfigurationSchema,
  StartInferenceOAuthSchema,
  UpdateInferenceProviderConnectionSchema,
  UpdateInferenceProviderRoutingSchema,
} from '@/modules/inference/inference.schemas.js';
import { InferenceTokenService } from '@/modules/inference/inference-token.service.js';
import { InferenceModelService } from '@/modules/inference/models/inference-model.service.js';
import { InferenceModelConfigurationService } from '@/modules/inference/models/inference-model-configuration.service.js';
import { InferenceOAuthService } from '@/modules/inference/providers/inference-oauth.service.js';
import { InferenceProviderService } from '@/modules/inference/providers/inference-provider.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { User } from '@/types.js';

export const INFERENCE_TOOL_NAMES = new Set([
  'manage_inference_provider',
  'manage_inference_model',
  'manage_inference_limits',
  'manage_inference_token',
]);

export async function executeInferenceTool(
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  await requireInferenceEnabled();
  if (toolName === 'manage_inference_provider') return manageProvider(user, args);
  if (toolName === 'manage_inference_model') return manageModel(user, args);
  if (toolName === 'manage_inference_limits') return manageLimits(user, args);
  if (toolName === 'manage_inference_token') return manageToken(user, args);
  throw new Error(`Unsupported inference tool: ${toolName}`);
}

async function manageProvider(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation, 'operation');
  const service = container.resolve(InferenceProviderService);
  if (operation === 'list_templates') {
    requireScope(user, 'inference:providers:view');
    return service.listCatalog();
  }
  if (operation === 'list_connections') {
    requireScope(user, 'inference:providers:view');
    return service.listConnections();
  }
  requireScope(user, 'inference:providers:manage');
  if (operation === 'connect_api_key') {
    return service.createKeyConnection(
      user.id,
      CreateInferenceProviderConnectionSchema.parse({
        providerId: args.providerId,
        name: args.name,
        authType: args.authType,
        apiKey: args.apiKey,
        baseUrl: args.baseUrl,
        allowPrivateNetwork: args.allowPrivateNetwork,
      })
    );
  }
  if (operation === 'start_authorization') {
    return container.resolve(InferenceOAuthService).start(
      user.id,
      StartInferenceOAuthSchema.parse({
        providerId: args.providerId,
        connectionName: args.connectionName,
        acceptTerms: args.acceptTerms,
        termsVersion: args.termsVersion,
      })
    );
  }
  if (operation === 'authorization_status') {
    const session = await container
      .resolve(InferenceOAuthService)
      .status(user.id, requiredString(args.sessionId, 'sessionId'));
    if (session.status === 'complete' && session.connectionId) {
      await service.syncConnection(session.connectionId, true);
    }
    return session;
  }
  if (operation === 'cancel_authorization') {
    return container.resolve(InferenceOAuthService).cancel(user.id, requiredString(args.sessionId, 'sessionId'));
  }
  if (operation === 'sync') {
    return service.syncConnection(requiredString(args.connectionId, 'connectionId'), true);
  }
  if (operation === 'update') {
    const apiMonthlyLimitMicrodollars =
      args.apiMonthlyLimitUsd === undefined
        ? undefined
        : args.apiMonthlyLimitUsd === null
          ? null
          : usdToMicrodollars(args.apiMonthlyLimitUsd);
    const input = UpdateInferenceProviderConnectionSchema.parse({
      enabled: args.enabled,
      name: args.name,
      routingOrder: args.routingOrder,
      minimumRemainingPercent: args.minimumRemainingPercent,
      apiMonthlyLimitMicrodollars,
    });
    return service.updateConnection(user.id, requiredString(args.connectionId, 'connectionId'), input);
  }
  if (operation === 'set_routing') {
    const input = UpdateInferenceProviderRoutingSchema.parse({ routingStrategy: args.routingStrategy });
    return service.setRoutingStrategy(user.id, requiredString(args.providerId, 'providerId'), input.routingStrategy);
  }
  if (operation === 'disconnect') {
    await service.disconnect(user.id, requiredString(args.connectionId, 'connectionId'));
    return { success: true };
  }
  throw new Error(`Unsupported inference provider operation: ${operation}`);
}

async function manageModel(user: User, args: Record<string, unknown>) {
  requireScope(user, 'inference:models:manage');
  const operation = requiredString(args.operation, 'operation');
  if (operation === 'list') return container.resolve(InferenceModelService).listAdmin();
  if (operation === 'suggestions') {
    return container.resolve(InferenceModelService).suggestions(requiredString(args.modelId, 'modelId'));
  }
  if (operation === 'save') {
    const configuration = InferenceModelConfigurationSchema.parse(args.configuration);
    const modelId = optionalString(args.modelId);
    return container.resolve(InferenceModelConfigurationService).save(user.id, modelId, configuration);
  }
  if (operation === 'delete') {
    await container.resolve(InferenceModelService).remove(user.id, requiredString(args.modelId, 'modelId'));
    return { success: true };
  }
  throw new Error(`Unsupported inference model operation: ${operation}`);
}

async function manageLimits(user: User, args: Record<string, unknown>) {
  requireScope(user, 'inference:limits:manage');
  const operation = requiredString(args.operation, 'operation');
  const service = container.resolve(InferenceUsageService);
  if (operation === 'list_policies') return service.listPolicies();
  if (operation === 'list_users') return service.limitUsers();
  if (operation === 'set_default') {
    return service.setDefault(user.id, InferenceLimitPolicyInputSchema.parse(args.policy));
  }
  if (operation === 'set_user') {
    return service.setUser(
      user.id,
      requiredString(args.userId, 'userId'),
      InferenceLimitPolicyInputSchema.parse(args.policy)
    );
  }
  if (operation === 'remove_user') {
    await service.removeUser(user.id, requiredString(args.userId, 'userId'));
    return { success: true };
  }
  throw new Error(`Unsupported inference limits operation: ${operation}`);
}

async function manageToken(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation, 'operation');
  const service = container.resolve(InferenceTokenService);
  if (operation === 'list') {
    requireScope(user, 'inference:tokens:manage');
    return (await service.listTokens(user.id)).filter((token) => token.status === 'active');
  }
  if (operation === 'create') {
    requireScope(user, 'inference:tokens:manage');
    return service.createToken(user.id, CreateInferenceTokenSchema.parse({ name: args.name }));
  }
  if (operation === 'revoke') {
    requireScope(user, 'inference:tokens:manage');
    await service.revokeToken(user.id, requiredString(args.tokenId, 'tokenId'));
    return { success: true };
  }
  throw new Error(`Unsupported inference token operation: ${operation}`);
}

async function requireInferenceEnabled(): Promise<void> {
  if (!(await container.resolve(GeneralSettingsService).isFeatureEnabled('inferenceEnabled'))) {
    throw new Error(
      'Inference is disabled for this Gateway. An administrator can enable generalSettings.features.inferenceEnabled.'
    );
  }
}

function requireScope(user: User, scope: string): void {
  if (!hasScope(user.scopes, scope)) throw new Error(`PERMISSION_DENIED: ${scope} is required`);
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function usdToMicrodollars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('apiMonthlyLimitUsd must be a non-negative number or null');
  }
  const result = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(result)) throw new Error('apiMonthlyLimitUsd is too large');
  return result;
}
