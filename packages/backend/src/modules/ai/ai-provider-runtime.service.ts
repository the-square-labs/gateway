import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { AppError } from '@/middleware/error-handler.js';
import type { InferenceRuntimeService } from '@/modules/inference/inference-runtime.service.js';
import type { InferenceModelService } from '@/modules/inference/models/inference-model.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { User } from '@/types.js';
import { streamGatewayInferenceResponse } from './ai.gateway-inference-adapter.js';
import { type AIModelTool, type ModelProviderEvent, streamModelResponse } from './ai.provider-adapter.js';
import type { AISettingsService } from './ai.settings.service.js';
import type { AIConfig } from './ai.types.js';

const GATEWAY_INFERENCE_MAX_TOOL_ROUNDS = 20;

export interface AIInferenceModelOption {
  id: string;
  displayName: string;
  supportsImages: boolean;
  maxContextTokens: number;
  maxOutputTokens: number | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

export interface AIProviderStatus {
  enabled: boolean;
  providerType: AIConfig['providerType'];
  defaultModel: string;
  allowUserModelSelection: boolean;
  supportsImages: boolean;
  models: AIInferenceModelOption[];
}

export interface AIProviderSession {
  config: AIConfig;
  reasoningEffort: string | null;
  stream: (messages: Record<string, unknown>[], tools: AIModelTool[]) => AsyncGenerator<ModelProviderEvent>;
}

interface ResolveSessionOptions {
  requestId: string;
  conversationId?: string;
  requestedModel?: string;
  requestedReasoningEffort?: string;
  signal: AbortSignal;
  isCompaction?: boolean;
}

export class AIProviderRuntimeService {
  constructor(
    private readonly settings: AISettingsService,
    private readonly generalSettings: GeneralSettingsService,
    private readonly inferenceModels: InferenceModelService,
    private readonly inferenceRuntime: InferenceRuntimeService
  ) {}

  async adminModels(): Promise<AIInferenceModelOption[]> {
    if (!(await this.generalSettings.isFeatureEnabled('inferenceEnabled'))) return [];
    const models = await this.inferenceModels.listAdmin();
    return models.filter((model) => model.enabled).map(toAdminModelOption);
  }

  async statusForUser(user: User): Promise<AIProviderStatus> {
    const config = await this.settings.getConfig();
    if (config.providerType !== 'gateway_inference') {
      return {
        enabled: await this.settings.isEnabled(),
        providerType: config.providerType,
        defaultModel: config.model,
        allowUserModelSelection: false,
        supportsImages: config.supportsImages,
        models: [],
      };
    }

    if (!(await this.generalSettings.isFeatureEnabled('inferenceEnabled'))) {
      return {
        enabled: false,
        providerType: config.providerType,
        defaultModel: config.gatewayInferenceModel,
        allowUserModelSelection: config.gatewayInferenceAllowUserModelSelection,
        supportsImages: false,
        models: [],
      };
    }
    const models = (await this.inferenceModels.listForUser(user)).data.map(toPublicModelOption);
    const defaultAvailable = models.some((model) => model.id === config.gatewayInferenceModel);
    return {
      enabled:
        config.enabled &&
        this.inferenceRuntime.isConfigured() &&
        models.length > 0 &&
        (defaultAvailable || config.gatewayInferenceAllowUserModelSelection),
      providerType: config.providerType,
      defaultModel: defaultAvailable ? config.gatewayInferenceModel : (models[0]?.id ?? config.gatewayInferenceModel),
      allowUserModelSelection: config.gatewayInferenceAllowUserModelSelection,
      supportsImages:
        models.find((model) => model.id === config.gatewayInferenceModel)?.supportsImages ??
        models[0]?.supportsImages ??
        false,
      models,
    };
  }

  async resolveSession(user: User, options: ResolveSessionOptions): Promise<AIProviderSession> {
    const config = await this.settings.getConfig();
    if (config.providerType === 'openai_compatible') {
      const apiKey = await this.settings.getDecryptedApiKey();
      if (!apiKey) {
        throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI is not configured. An admin must set up the API key.');
      }
      const client = new OpenAI({ apiKey, baseURL: config.providerUrl || undefined });
      return {
        config,
        reasoningEffort: config.reasoningEffort === 'none' ? null : config.reasoningEffort,
        stream: (messages, tools) => streamModelResponse({ client, config, messages, tools, signal: options.signal }),
      };
    }

    if (!(await this.generalSettings.isFeatureEnabled('inferenceEnabled'))) {
      throw new AppError(503, 'AI_GATEWAY_INFERENCE_DISABLED', 'Gateway Inference is disabled');
    }
    if (!this.inferenceRuntime.isConfigured()) {
      throw new AppError(503, 'INFERENCE_NOT_CONFIGURED', 'Gateway Inference is not configured');
    }

    const models = (await this.inferenceModels.listForUser(user)).data;
    const requestedModel = options.requestedModel?.trim();
    if (
      requestedModel &&
      requestedModel !== config.gatewayInferenceModel &&
      !config.gatewayInferenceAllowUserModelSelection
    ) {
      throw new AppError(403, 'AI_MODEL_SELECTION_DISABLED', 'AI model selection is disabled');
    }

    let selected = models.find((model) => model.id === (requestedModel || config.gatewayInferenceModel));
    if (!selected && !requestedModel && config.gatewayInferenceAllowUserModelSelection) selected = models[0];
    if (!selected) {
      throw new AppError(404, 'AI_MODEL_UNAVAILABLE', 'The selected Gateway Inference model is unavailable');
    }
    const requestedReasoningEffort = options.requestedReasoningEffort?.trim();
    if (requestedReasoningEffort && !selected.supported_reasoning_efforts.includes(requestedReasoningEffort)) {
      throw new AppError(
        400,
        'AI_REASONING_EFFORT_UNAVAILABLE',
        'The selected reasoning effort is unavailable for this model'
      );
    }
    const reasoningEffort = requestedReasoningEffort || selected.default_reasoning_effort || null;

    const effectiveConfig: AIConfig = {
      ...config,
      model: selected.id,
      supportsImages: selected.input_modalities.includes('image'),
      maxContextTokens: selected.auto_compact_token_limit,
      maxCompletionTokens: selected.max_output_tokens ?? config.maxCompletionTokens,
      maxToolRounds: GATEWAY_INFERENCE_MAX_TOOL_ROUNDS,
    };

    return {
      config: effectiveConfig,
      reasoningEffort,
      stream: (messages, tools) =>
        streamGatewayInferenceResponse({
          runtime: this.inferenceRuntime,
          userId: user.id,
          requestId: `${options.requestId}:${randomUUID()}`,
          conversationId: options.conversationId,
          model: selected.id,
          messages,
          tools,
          maxOutputTokens: selected.max_output_tokens ?? undefined,
          reasoningEffort: reasoningEffort ?? undefined,
          signal: options.signal,
          isCompaction: options.isCompaction,
        }),
    };
  }
}

function toAdminModelOption(model: {
  publicId: string;
  displayName: string;
  modalities: string[];
  autoCompactTokenLimit: number;
  maxOutputTokens: number | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}): AIInferenceModelOption {
  return {
    id: model.publicId,
    displayName: model.displayName,
    supportsImages: model.modalities.includes('image'),
    maxContextTokens: model.autoCompactTokenLimit,
    maxOutputTokens: model.maxOutputTokens,
    reasoningEfforts: model.reasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
  };
}

function toPublicModelOption(model: {
  id: string;
  display_name: string;
  input_modalities: string[];
  auto_compact_token_limit: number;
  max_output_tokens?: number;
  supported_reasoning_efforts: string[];
  default_reasoning_effort: string | null;
}): AIInferenceModelOption {
  return {
    id: model.id,
    displayName: model.display_name,
    supportsImages: model.input_modalities.includes('image'),
    maxContextTokens: model.auto_compact_token_limit,
    maxOutputTokens: model.max_output_tokens ?? null,
    reasoningEfforts: model.supported_reasoning_efforts,
    defaultReasoningEffort: model.default_reasoning_effort,
  };
}
