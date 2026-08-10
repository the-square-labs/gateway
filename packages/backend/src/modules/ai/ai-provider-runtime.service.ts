import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { AppError } from '@/middleware/error-handler.js';
import type { InferenceBudgetPolicyService } from '@/modules/inference/accounting/inference-budget-policy.js';
import type { InferenceRuntimeService } from '@/modules/inference/inference-runtime.service.js';
import type { InferenceModelService } from '@/modules/inference/models/inference-model.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { User } from '@/types.js';
import { streamGatewayInferenceResponse } from './ai.gateway-inference-adapter.js';
import { type AIModelTool, type ModelProviderEvent, streamModelResponse } from './ai.provider-adapter.js';
import type { AISettingsService } from './ai.settings.service.js';
import type { AIConfig, AIContextLimits } from './ai.types.js';
import { directProviderContextLimits, normalizeAIContextLimits } from './ai-context-limits.js';

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
  contextLimits: AIContextLimits;
  reasoningEffort: string | null;
  stream: (
    messages: Record<string, unknown>[],
    tools: AIModelTool[],
    options?: { maxOutputTokens?: number }
  ) => AsyncGenerator<ModelProviderEvent>;
}

interface ResolveSessionOptions {
  requestId: string;
  conversationId?: string;
  requestedModel?: string;
  requestedReasoningEffort?: string;
  preferMinimumReasoning?: boolean;
  signal: AbortSignal;
  isCompaction?: boolean;
}

interface GenerateConversationTitleOptions {
  requestId: string;
  content: string;
  requestedModel?: string;
  signal: AbortSignal;
}

const CONVERSATION_TITLE_SYSTEM_PROMPT = [
  'Generate a concise title for this chat.',
  'Use the same language as the user.',
  'Do not analyze, reason through the request, or explain anything; answer immediately.',
  'Return only the title: 3 to 7 words, no quotes, no markdown, no trailing punctuation.',
].join(' ');
const CONVERSATION_TITLE_MAX_OUTPUT_TOKENS = 512;

export class AIProviderRuntimeService {
  constructor(
    private readonly settings: AISettingsService,
    private readonly generalSettings: GeneralSettingsService,
    private readonly inferenceModels: InferenceModelService,
    private readonly inferenceRuntime: InferenceRuntimeService,
    private readonly inferencePolicies: InferenceBudgetPolicyService
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
    const [modelsResult, limits] = await Promise.all([
      this.inferenceModels.listForUser(user),
      this.inferencePolicies.effective(user.id),
    ]);
    const models = modelsResult.data.map(toPublicModelOption);
    const defaultAvailable = models.some((model) => model.id === config.gatewayInferenceModel);
    return {
      enabled:
        config.enabled &&
        this.inferenceRuntime.isConfigured() &&
        limits.enabled &&
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
      const contextLimits = directProviderContextLimits(config.maxContextTokens, config.maxCompletionTokens);
      const effectiveConfig = options.preferMinimumReasoning ? { ...config, reasoningEffort: 'none' as const } : config;
      return {
        config: effectiveConfig,
        contextLimits,
        reasoningEffort: effectiveConfig.reasoningEffort === 'none' ? null : effectiveConfig.reasoningEffort,
        stream: (messages, tools, streamOptions) =>
          streamModelResponse({
            client,
            config: streamOptions?.maxOutputTokens
              ? {
                  ...effectiveConfig,
                  maxCompletionTokens: Math.min(effectiveConfig.maxCompletionTokens, streamOptions.maxOutputTokens),
                }
              : effectiveConfig,
            messages,
            tools,
            signal: options.signal,
          }),
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
    const reasoningEffort = options.preferMinimumReasoning
      ? minimumReasoningEffort(selected.supported_reasoning_efforts)
      : requestedReasoningEffort || selected.default_reasoning_effort || null;
    const contextLimits = normalizeAIContextLimits({
      contextWindow: selected.context_window,
      maxInputTokens: selected.max_input_tokens,
      autoCompactTokenLimit: selected.auto_compact_token_limit,
      maxOutputTokens: selected.max_output_tokens,
    });

    const effectiveConfig: AIConfig = {
      ...config,
      model: selected.id,
      supportsImages: selected.input_modalities.includes('image'),
      maxContextTokens: contextLimits.maxInputTokens,
      maxCompletionTokens: selected.max_output_tokens ?? config.maxCompletionTokens,
      maxToolRounds: GATEWAY_INFERENCE_MAX_TOOL_ROUNDS,
    };

    return {
      config: effectiveConfig,
      contextLimits,
      reasoningEffort,
      stream: (messages, tools, streamOptions) =>
        streamGatewayInferenceResponse({
          runtime: this.inferenceRuntime,
          userId: user.id,
          requestId: `${options.requestId}:${randomUUID()}`,
          conversationId: options.conversationId,
          model: selected.id,
          messages,
          tools,
          maxOutputTokens: streamOptions?.maxOutputTokens
            ? Math.min(selected.max_output_tokens ?? streamOptions.maxOutputTokens, streamOptions.maxOutputTokens)
            : (selected.max_output_tokens ?? undefined),
          reasoningEffort: reasoningEffort ?? undefined,
          signal: options.signal,
          isCompaction: options.isCompaction,
        }),
    };
  }

  async generateConversationTitle(user: User, options: GenerateConversationTitleOptions): Promise<string> {
    const session = await this.resolveSession(user, {
      requestId: options.requestId,
      requestedModel: options.requestedModel,
      preferMinimumReasoning: true,
      signal: options.signal,
    });
    let streamedContent = '';
    let finalContent = '';
    for await (const event of session.stream(
      [
        { role: 'system', content: CONVERSATION_TITLE_SYSTEM_PROMPT },
        { role: 'user', content: options.content },
      ],
      [],
      { maxOutputTokens: CONVERSATION_TITLE_MAX_OUTPUT_TOKENS }
    )) {
      if (event.type === 'text_delta') streamedContent += event.content;
      if (event.type === 'model_response') finalContent = event.response.content;
    }
    const title = normalizeGeneratedConversationTitle(finalContent || streamedContent);
    if (!title) {
      throw new AppError(502, 'AI_CONVERSATION_TITLE_EMPTY', 'The AI model returned an empty conversation title');
    }
    return title;
  }
}

function minimumReasoningEffort(efforts: string[]): string | null {
  if (efforts.length === 0) return null;
  const rank = new Map([
    ['none', 0],
    ['minimal', 1],
    ['low', 2],
    ['medium', 3],
    ['high', 4],
    ['xhigh', 5],
    ['max', 6],
    ['ultra', 7],
  ]);
  return efforts.reduce((minimum, candidate) => {
    const minimumRank = rank.get(minimum.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const candidateRank = rank.get(candidate.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    return candidateRank < minimumRank ? candidate : minimum;
  });
}

export function normalizeGeneratedConversationTitle(value: string): string {
  const title = value
    .trim()
    .split(/\r?\n/, 1)[0]
    ?.replace(/^#{1,6}\s*/, '')
    .replace(/^\*{0,2}(?:title|название)\s*:\*{0,2}\s*/i, '')
    .replace(/^[`"'«“]+|[`"'»”]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?;:]+$/u, '')
    .trim();
  return title?.slice(0, 80).trim() ?? '';
}

function toAdminModelOption(model: {
  publicId: string;
  displayName: string;
  modalities: string[];
  maxInputTokens: number;
  maxOutputTokens: number | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}): AIInferenceModelOption {
  return {
    id: model.publicId,
    displayName: model.displayName,
    supportsImages: model.modalities.includes('image'),
    maxContextTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    reasoningEfforts: model.reasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
  };
}

function toPublicModelOption(model: {
  id: string;
  display_name: string;
  input_modalities: string[];
  max_input_tokens: number;
  max_output_tokens?: number;
  supported_reasoning_efforts: string[];
  default_reasoning_effort: string | null;
}): AIInferenceModelOption {
  return {
    id: model.id,
    displayName: model.display_name,
    supportsImages: model.input_modalities.includes('image'),
    maxContextTokens: model.max_input_tokens,
    maxOutputTokens: model.max_output_tokens ?? null,
    reasoningEfforts: model.supported_reasoning_efforts,
    defaultReasoningEffort: model.default_reasoning_effort,
  };
}
