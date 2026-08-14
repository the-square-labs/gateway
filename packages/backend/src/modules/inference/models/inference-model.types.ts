export interface InferenceModelInput {
  publicId: string;
  displayName: string;
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number | null;
  autoCompactTokenLimit: number;
  modalities: string[];
  capabilities: Record<string, boolean>;
  reasoningEfforts: string[];
  defaultReasoningEffort?: string | null;
  defaultAccessAllowed: boolean;
  subscriptionMultiplier: number;
}

export interface InferenceModelSourceInput {
  connectionId: string;
  discoveredModelId?: string;
  upstreamModelId?: string;
  enabled?: boolean;
  subscriptionMultiplierOverride?: number | null;
  reasoningEffortMap: Record<string, string>;
  capabilitiesOverride?: Record<string, boolean> | null;
  manualMetadata?: {
    contextWindow?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    autoCompactTokenLimit?: number;
  };
  pricing?: InferencePricingInput;
}

export interface InferencePricingInput {
  version: string;
  inputMicrodollarsPerMillion?: number | null;
  cachedInputMicrodollarsPerMillion?: number | null;
  cacheWriteMicrodollarsPerMillion?: number | null;
  outputMicrodollarsPerMillion?: number | null;
  reasoningMicrodollarsPerMillion?: number | null;
  otherUnitPrices?: Record<string, number>;
  source: 'provider' | 'manual';
}

export interface InferenceModelConfigurationInput {
  model: InferenceModelInput;
  sources: InferenceModelSourceInput[];
  access: {
    mode: 'everyone' | 'selected' | 'disabled';
    subjects: Array<{ subjectType: 'group' | 'user'; subjectId: string }>;
  };
}
