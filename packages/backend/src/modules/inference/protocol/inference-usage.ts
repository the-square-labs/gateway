import type {
  InferenceContentPart,
  InferenceMessage,
  InferenceOutputItem,
  InferenceUsage,
} from './inference-protocol.types.js';

function textLength(part: InferenceContentPart): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return part.text.length;
    case 'tool_call':
      return part.name.length + part.arguments.length;
    case 'tool_result':
      return part.output.length;
    case 'compaction':
      return part.encryptedContent.length;
    case 'image':
    case 'file':
      return 4_000;
    case 'hosted':
      return JSON.stringify(part.raw).length;
  }
}

export function estimateInputTokens(messages: InferenceMessage[]): number {
  const characters = messages.reduce(
    (sum, message) => sum + message.content.reduce((contentSum, part) => contentSum + textLength(part), 0),
    0
  );
  return Math.max(1, Math.ceil(characters / 3));
}

export function estimateOutputTokens(items: InferenceOutputItem[]): number {
  const characters = items.reduce((sum, item) => {
    if (item.type === 'message' || item.type === 'reasoning') return sum + item.text.length;
    if (item.type === 'function_call') return sum + item.name.length + item.arguments.length;
    if (item.type === 'hosted') return sum + JSON.stringify(item.raw).length;
    return sum + item.encryptedContent.length;
  }, 0);
  return Math.max(items.length > 0 ? 1 : 0, Math.ceil(characters / 3));
}

export function completeUsage(
  usage: Partial<InferenceUsage> | undefined,
  messages: InferenceMessage[],
  items: InferenceOutputItem[]
): InferenceUsage {
  const estimatedInput = estimateInputTokens(messages);
  const estimatedOutput = estimateOutputTokens(items);
  const inputTokens = nonnegative(usage?.inputTokens, estimatedInput);
  const cachedInputTokens = nonnegative(usage?.cachedInputTokens, 0);
  const cacheWriteTokens = nonnegative(usage?.cacheWriteTokens, 0);
  const outputTokens = nonnegative(usage?.outputTokens, estimatedOutput);
  const reasoningTokens = nonnegative(usage?.reasoningTokens, 0);
  const computedTotal = inputTokens + outputTokens + reasoningTokens;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens:
      usage?.totalTokens != null
        ? Math.max(nonnegative(usage.totalTokens, computedTotal), computedTotal)
        : computedTotal,
    estimated: usage?.estimated ?? (usage?.inputTokens == null || usage?.outputTokens == null),
  };
}

function nonnegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : fallback;
}
