import { compactionItemToText } from './inference-compaction.js';
import { InferenceProtocolError } from './inference-protocol.error.js';
import type {
  InferenceContentPart,
  InferenceMessage,
  InferenceMessagePhase,
  InferenceRequest,
  InferenceRole,
  InferenceTool,
} from './inference-protocol.types.js';

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InferenceProtocolError(400, 'invalid_request_error', `${label} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InferenceProtocolError(400, 'invalid_request_error', `${label} must be a non-empty string`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InferenceProtocolError(400, 'invalid_request_error', `${label} must be a positive integer`);
  }
  return value;
}

function role(value: unknown): InferenceRole {
  if (value === 'system' || value === 'developer' || value === 'user' || value === 'assistant') return value;
  throw new InferenceProtocolError(400, 'invalid_request_error', `Unsupported message role: ${String(value)}`);
}

function messagePhase(value: unknown): InferenceMessagePhase | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'commentary' || value === 'final_answer') return value;
  throw new InferenceProtocolError(400, 'invalid_request_error', `Unsupported message phase: ${String(value)}`);
}

function contentParts(value: unknown, context: 'openai' | 'anthropic'): InferenceContentPart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'Message content must be a string or array');
  }

  return value.map((rawPart) => {
    const part = object(rawPart, 'content block');
    const type = requiredString(part.type, 'content block type');
    if (type === 'text' || type === 'input_text' || type === 'output_text' || type === 'summary_text') {
      return {
        type: 'text',
        text: requiredString(part.text, `${type}.text`),
        ...(part.cache_control !== undefined ? { cacheControl: part.cache_control } : {}),
      };
    }
    if (type === 'image' || type === 'input_image' || type === 'image_url') {
      return { type: 'image', source: part };
    }
    if (type === 'thinking' || type === 'reasoning' || type === 'reasoning_text' || type === 'redacted_thinking') {
      const text = typeof part.thinking === 'string' ? part.thinking : typeof part.text === 'string' ? part.text : '';
      return {
        type: 'reasoning',
        text,
        ...(typeof part.id === 'string' ? { id: part.id } : {}),
        ...(typeof part.signature === 'string' ? { signature: part.signature } : {}),
        ...(type === 'redacted_thinking' && typeof part.data === 'string' ? { redactedData: part.data } : {}),
        ...(part.cache_control !== undefined ? { cacheControl: part.cache_control } : {}),
      };
    }
    if (type === 'tool_use') {
      return {
        type: 'tool_call',
        id: requiredString(part.id, 'tool_use.id'),
        callId: requiredString(part.id, 'tool_use.id'),
        name: requiredString(part.name, 'tool_use.name'),
        arguments: JSON.stringify(part.input ?? {}),
        ...(part.cache_control !== undefined ? { cacheControl: part.cache_control } : {}),
      };
    }
    if (type === 'tool_result') {
      const output = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
      return {
        type: 'tool_result',
        callId: requiredString(part.tool_use_id, 'tool_result.tool_use_id'),
        output,
        ...(part.is_error === true ? { isError: true } : {}),
        ...(part.cache_control !== undefined ? { cacheControl: part.cache_control } : {}),
      };
    }
    if (context === 'openai' && type === 'input_file') {
      return { type: 'file', source: part };
    }
    if (context === 'anthropic' && type === 'document') {
      return {
        type: 'file',
        source: part,
        ...(part.cache_control !== undefined ? { cacheControl: part.cache_control } : {}),
      };
    }
    throw new InferenceProtocolError(400, 'invalid_request_error', `Unsupported content block type: ${type}`);
  });
}

function parseTools(value: unknown): InferenceTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new InferenceProtocolError(400, 'invalid_request_error', 'tools must be an array');
  return value.flatMap<InferenceTool>((rawTool): InferenceTool[] => {
    const tool = object(rawTool, 'tool');
    if (tool.type === 'namespace') {
      const namespace = requiredString(tool.name, 'tool.name');
      if (!Array.isArray(tool.tools)) {
        throw new InferenceProtocolError(400, 'invalid_request_error', 'namespace tools must be an array');
      }
      return parseTools(tool.tools).map((nested) => {
        if (nested.type === 'hosted') {
          throw new InferenceProtocolError(
            400,
            'invalid_request_error',
            'namespace entries must be client-executed tools'
          );
        }
        return { ...nested, namespace };
      });
    }
    if (typeof tool.name === 'string' && tool.type === undefined) {
      return [
        {
          type: 'function',
          name: requiredString(tool.name, 'tool.name'),
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          ...(tool.input_schema && typeof tool.input_schema === 'object'
            ? { inputSchema: tool.input_schema as Record<string, unknown> }
            : {}),
          raw: tool,
        },
      ];
    }
    if (tool.type === 'function' && tool.function && typeof tool.function === 'object') {
      const fn = object(tool.function, 'tool.function');
      return [
        {
          type: 'function',
          name: requiredString(fn.name, 'tool.function.name'),
          ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
          ...(fn.parameters && typeof fn.parameters === 'object'
            ? { inputSchema: fn.parameters as Record<string, unknown> }
            : {}),
          raw: tool,
        },
      ];
    }
    if (tool.type === 'function' || tool.type === 'custom') {
      return [
        {
          type: tool.type,
          name: requiredString(tool.name, 'tool.name'),
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          ...(tool.parameters && typeof tool.parameters === 'object'
            ? { inputSchema: tool.parameters as Record<string, unknown> }
            : tool.input_schema && typeof tool.input_schema === 'object'
              ? { inputSchema: tool.input_schema as Record<string, unknown> }
              : {}),
          raw: tool,
        },
      ];
    }
    const hostedName = requiredString(tool.type, 'tool.type');
    return [{ type: 'hosted', name: hostedName, raw: tool }];
  });
}

function extensions(raw: JsonObject, known: readonly string[], supported: readonly string[]): Record<string, unknown> {
  const knownSet = new Set(known);
  const extensionEntries = Object.entries(raw).filter(([key]) => !knownSet.has(key));
  const supportedSet = new Set([...supported, 'idempotency_key']);
  const unsupported = extensionEntries.find(([key]) => !supportedSet.has(key));
  if (unsupported) {
    throw new InferenceProtocolError(400, 'invalid_request_error', `Unsupported request field: ${unsupported[0]}`);
  }
  return Object.fromEntries(extensionEntries);
}

function parseResponsesInput(value: unknown): {
  messages: InferenceMessage[];
  tools: InferenceTool[];
  isCompaction: boolean;
} {
  if (value === undefined) return { messages: [], tools: [], isCompaction: false };
  if (typeof value === 'string')
    return {
      messages: [{ role: 'user', content: [{ type: 'text', text: value }] }],
      tools: [],
      isCompaction: false,
    };
  if (!Array.isArray(value))
    throw new InferenceProtocolError(400, 'invalid_request_error', 'input must be a string or array');

  const messages: InferenceMessage[] = [];
  const tools: InferenceTool[] = [];
  let isCompaction = false;
  for (const rawItem of value) {
    const item = object(rawItem, 'input item');
    const type = typeof item.type === 'string' ? item.type : 'message';
    if (type === 'compaction_trigger') {
      isCompaction = true;
      continue;
    }
    if (type === 'message') {
      const phase = messagePhase(item.phase);
      messages.push({
        role: role(item.role),
        content: contentParts(item.content, 'openai'),
        ...(phase ? { phase } : {}),
      });
      continue;
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            id: typeof item.id === 'string' ? item.id : requiredString(item.call_id, 'function_call.call_id'),
            callId: requiredString(item.call_id ?? item.id, 'function_call.call_id'),
            name: requiredString(item.name, 'function_call.name'),
            ...(typeof item.namespace === 'string' ? { namespace: item.namespace } : {}),
            arguments:
              type === 'custom_tool_call'
                ? requiredString(item.input ?? item.arguments, 'custom_tool_call.input')
                : typeof item.arguments === 'string'
                  ? item.arguments
                  : JSON.stringify(item.input ?? {}),
            ...(type === 'custom_tool_call' ? { custom: true } : {}),
          },
        ],
      });
      continue;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            callId: requiredString(item.call_id, `${type}.call_id`),
            output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
            ...(type === 'custom_tool_call_output' ? { custom: true } : {}),
          },
        ],
      });
      continue;
    }
    if (type === 'reasoning') {
      const parts = contentParts(item.content ?? item.summary ?? [], 'openai');
      for (const part of parts) {
        if (part.type === 'reasoning' && typeof item.id === 'string') part.id = item.id;
      }
      if (typeof item.encrypted_content === 'string') {
        const reasoning = parts.find((part) => part.type === 'reasoning');
        if (reasoning?.type === 'reasoning') reasoning.signature = item.encrypted_content;
        else
          parts.push({
            type: 'reasoning',
            ...(typeof item.id === 'string' ? { id: item.id } : {}),
            text: '',
            signature: item.encrypted_content,
          });
      }
      messages.push({ role: 'assistant', content: parts });
      continue;
    }
    if (type === 'compaction') {
      const encrypted = requiredString(item.encrypted_content, 'compaction.encrypted_content');
      messages.push({ role: 'user', content: [{ type: 'text', text: compactionItemToText(encrypted) }] });
      continue;
    }
    if (type === 'additional_tools') {
      tools.push(...parseTools(item.tools));
      continue;
    }
    throw new InferenceProtocolError(400, 'invalid_request_error', `Unsupported input item type: ${type}`);
  }
  return { messages, tools, isCompaction };
}

function mergeTools(...groups: InferenceTool[][]): InferenceTool[] {
  const merged: InferenceTool[] = [];
  const indexes = new Map<string, number>();
  for (const tool of groups.flat()) {
    const key = `${tool.namespace ?? ''}\u0000${tool.name}`;
    const existing = indexes.get(key);
    if (existing === undefined) {
      indexes.set(key, merged.length);
      merged.push(tool);
    } else {
      merged[existing] = tool;
    }
  }
  return merged;
}

export function parseResponsesRequest(value: unknown): InferenceRequest {
  const raw = object(value, 'request body');
  const parsedInput = parseResponsesInput(raw.input);
  const messages = [...parsedInput.messages];
  if (typeof raw.instructions === 'string' && raw.instructions.length > 0) {
    messages.unshift({ role: 'developer', content: [{ type: 'text', text: raw.instructions }] });
  }
  return {
    protocol: 'responses',
    model: requiredString(raw.model, 'model'),
    messages,
    tools: mergeTools(parseTools(raw.tools), parsedInput.tools),
    toolChoice: raw.tool_choice,
    stream: raw.stream === true,
    maxOutputTokens: optionalPositiveInteger(raw.max_output_tokens, 'max_output_tokens'),
    reasoningEffort: objectString(raw.reasoning, 'effort'),
    ...(isObject(raw.reasoning) ? { reasoningConfig: raw.reasoning } : {}),
    previousResponseId: typeof raw.previous_response_id === 'string' ? raw.previous_response_id : undefined,
    promptCacheKey: typeof raw.prompt_cache_key === 'string' ? raw.prompt_cache_key : undefined,
    parallelToolCalls: typeof raw.parallel_tool_calls === 'boolean' ? raw.parallel_tool_calls : undefined,
    isCompaction: parsedInput.isCompaction,
    extensions: extensions(
      raw,
      [
        'model',
        'input',
        'instructions',
        'tools',
        'tool_choice',
        'stream',
        'max_output_tokens',
        'reasoning',
        'previous_response_id',
        'prompt_cache_key',
        'parallel_tool_calls',
        'stream_options',
      ],
      [
        'temperature',
        'top_p',
        'service_tier',
        'truncation',
        'store',
        'metadata',
        'max_tool_calls',
        'safety_identifier',
        'prompt_cache_retention',
        'text',
        'include',
        'client_metadata',
      ]
    ),
  };
}

function objectString(value: unknown, key: string): string | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof (value as JsonObject)[key] === 'string'
    ? ((value as JsonObject)[key] as string)
    : undefined;
}

export function parseChatCompletionsRequest(value: unknown): InferenceRequest {
  const raw = object(value, 'request body');
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'messages must be a non-empty array');
  }
  if (raw.n !== undefined && raw.n !== 1) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'Only n=1 is supported');
  }
  if (raw.logprobs === true || raw.top_logprobs !== undefined) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'Chat Completions logprobs are not supported');
  }
  const messages: InferenceMessage[] = [];
  for (const rawMessage of raw.messages) {
    const message = object(rawMessage, 'message');
    if (message.role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            callId: requiredString(message.tool_call_id, 'tool_call_id'),
            output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
          },
        ],
      });
      continue;
    }
    const messageRole = role(message.role);
    const parts = message.content == null ? [] : contentParts(message.content, 'openai');
    if (typeof message.reasoning_content === 'string') {
      parts.unshift({ type: 'reasoning', text: message.reasoning_content });
    }
    if (Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        const call = object(rawCall, 'tool call');
        const fn = object(call.function, 'tool call function');
        parts.push({
          type: 'tool_call',
          id: requiredString(call.id, 'tool call id'),
          callId: requiredString(call.id, 'tool call id'),
          name: requiredString(fn.name, 'tool call name'),
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
    }
    messages.push({ role: messageRole, content: parts });
  }
  return {
    protocol: 'chat_completions',
    model: requiredString(raw.model, 'model'),
    messages,
    tools: parseTools(raw.tools),
    toolChoice: raw.tool_choice,
    stream: raw.stream === true,
    maxOutputTokens: optionalPositiveInteger(raw.max_completion_tokens ?? raw.max_tokens, 'max_tokens'),
    reasoningEffort: typeof raw.reasoning_effort === 'string' ? raw.reasoning_effort : undefined,
    parallelToolCalls: typeof raw.parallel_tool_calls === 'boolean' ? raw.parallel_tool_calls : undefined,
    isCompaction: false,
    extensions: extensions(
      raw,
      [
        'model',
        'messages',
        'tools',
        'tool_choice',
        'stream',
        'max_completion_tokens',
        'max_tokens',
        'reasoning_effort',
        'parallel_tool_calls',
      ],
      [
        'temperature',
        'top_p',
        'stop',
        'frequency_penalty',
        'presence_penalty',
        'seed',
        'response_format',
        'logprobs',
        'top_logprobs',
        'n',
        'service_tier',
        'store',
        'metadata',
        'stream_options',
        'user',
      ]
    ),
  };
}

export function parseAnthropicMessagesRequest(value: unknown): InferenceRequest {
  const raw = object(value, 'request body');
  if (!Array.isArray(raw.messages)) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'messages must be an array');
  }
  const messages: InferenceMessage[] = [];
  if (raw.system !== undefined) {
    messages.push({ role: 'system', content: contentParts(raw.system, 'anthropic') });
  }
  for (const rawMessage of raw.messages) {
    const message = object(rawMessage, 'message');
    const messageRole = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : null;
    if (!messageRole)
      throw new InferenceProtocolError(400, 'invalid_request_error', 'Anthropic role must be user or assistant');
    messages.push({ role: messageRole, content: contentParts(message.content, 'anthropic') });
  }
  return {
    protocol: 'messages',
    model: requiredString(raw.model, 'model'),
    messages,
    tools: parseTools(raw.tools),
    toolChoice: raw.tool_choice,
    stream: raw.stream === true,
    maxOutputTokens: optionalPositiveInteger(raw.max_tokens, 'max_tokens'),
    reasoningEffort: objectString(raw.output_config, 'effort'),
    ...(isObject(raw.thinking) ? { reasoningConfig: raw.thinking } : {}),
    isCompaction: false,
    extensions: extensions(
      raw,
      ['model', 'messages', 'system', 'tools', 'tool_choice', 'stream', 'max_tokens', 'thinking'],
      [
        'temperature',
        'top_p',
        'top_k',
        'stop_sequences',
        'metadata',
        'service_tier',
        'output_config',
        'context_management',
      ]
    ),
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
