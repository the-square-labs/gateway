import type { ChatMessage, PageContext, WSServerMessage } from './ai.types.js';

export interface AIModelCheckpoint {
  pendingMessages: Record<string, unknown>[];
  pendingApproval: { id: string; name: string; arguments: Record<string, unknown> } | null;
  pendingCredential: {
    id: string;
    name: string;
    connectorId: string;
    arguments: Record<string, unknown>;
  } | null;
  allQuestions: Array<{ id: string; args: Record<string, unknown> }>;
  queuedApprovals: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export function toPageContext(value: Record<string, unknown> | null): PageContext | undefined {
  if (!value || typeof value.route !== 'string') return undefined;
  return {
    route: value.route,
    resourceType: typeof value.resourceType === 'string' ? value.resourceType : undefined,
    resourceId: typeof value.resourceId === 'string' ? value.resourceId : undefined,
  };
}

export function toChatMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.localOnly === true) return null;
  const role = message.role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') return null;
  return {
    role,
    content: typeof message.content === 'string' ? message.content : null,
    attachments: Array.isArray(message.attachments) ? (message.attachments as ChatMessage['attachments']) : undefined,
    tool_calls: Array.isArray(message.tool_calls) ? (message.tool_calls as ChatMessage['tool_calls']) : undefined,
    tool_call_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined,
    name: typeof message.name === 'string' ? message.name : undefined,
  };
}

export function questionTextFromArgs(args: Record<string, unknown>): string {
  return typeof args.question === 'string' && args.question.trim()
    ? args.question
    : 'The assistant needs clarification.';
}

export function toCheckpoint(event: WSServerMessage): Record<string, unknown> {
  const payload = event as WSServerMessage & {
    _pendingMessages?: unknown;
    _rawArguments?: unknown;
    _allQuestions?: unknown;
    _queuedApprovals?: unknown;
  };
  return {
    type: event.type,
    requestId: 'requestId' in event ? event.requestId : undefined,
    pendingMessages: Array.isArray(payload._pendingMessages) ? payload._pendingMessages : [],
    pendingApproval:
      event.type === 'tool_approval_required' &&
      'id' in event &&
      'name' in event &&
      typeof event.id === 'string' &&
      typeof event.name === 'string' &&
      isRecord(payload._rawArguments)
        ? { id: event.id, name: event.name, rawArguments: payload._rawArguments }
        : null,
    pendingCredential:
      event.type === 'credential_authorization_required' &&
      typeof event.id === 'string' &&
      typeof event.name === 'string' &&
      typeof event.connectorId === 'string' &&
      isRecord(payload._rawArguments)
        ? {
            id: event.id,
            name: event.name,
            connectorId: event.connectorId,
            rawArguments: payload._rawArguments,
          }
        : null,
    allQuestions: Array.isArray(payload._allQuestions) ? payload._allQuestions : [],
    queuedApprovals: Array.isArray(payload._queuedApprovals) ? payload._queuedApprovals : [],
  };
}

export function normalizeCheckpoint(value: Record<string, unknown> | null): AIModelCheckpoint {
  if (!value) {
    return {
      pendingMessages: [],
      pendingApproval: null,
      pendingCredential: null,
      allQuestions: [],
      queuedApprovals: [],
    };
  }

  return {
    pendingMessages: Array.isArray(value.pendingMessages) ? value.pendingMessages.filter(isRecord) : [],
    pendingApproval: normalizeQueuedApproval(value.pendingApproval, true),
    pendingCredential: normalizeCredentialCheckpoint(value.pendingCredential),
    allQuestions: Array.isArray(value.allQuestions)
      ? value.allQuestions
          .map(normalizeCheckpointQuestion)
          .filter((question): question is { id: string; args: Record<string, unknown> } => question !== null)
      : [],
    queuedApprovals: Array.isArray(value.queuedApprovals)
      ? value.queuedApprovals
          .map((approval) => normalizeQueuedApproval(approval, true))
          .filter(
            (approval): approval is { id: string; name: string; arguments: Record<string, unknown> } =>
              approval !== null
          )
      : [],
  };
}

function normalizeCredentialCheckpoint(value: unknown): AIModelCheckpoint['pendingCredential'] {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.connectorId !== 'string'
  ) {
    return null;
  }
  const rawArguments = isRecord(value.rawArguments) ? value.rawArguments : null;
  const displayArguments = isRecord(value.arguments) ? value.arguments : {};
  return {
    id: value.id,
    name: value.name,
    connectorId: value.connectorId,
    arguments: rawArguments ?? displayArguments,
  };
}

export function toClientCheckpoint(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  return {
    type: typeof value.type === 'string' ? value.type : undefined,
    requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
    allQuestions: Array.isArray(value.allQuestions)
      ? value.allQuestions.map(normalizeCheckpointQuestion).filter((question) => question !== null)
      : [],
    queuedApprovals: Array.isArray(value.queuedApprovals)
      ? value.queuedApprovals
          .map((approval) => normalizeQueuedApproval(approval, false))
          .filter((approval) => approval !== null)
      : [],
  };
}

function normalizeCheckpointQuestion(value: unknown): { id: string; args: Record<string, unknown> } | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    args: isRecord(value.args) ? value.args : {},
  };
}

function normalizeQueuedApproval(
  value: unknown,
  preferRawArguments = false
): { id: string; name: string; arguments: Record<string, unknown> } | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return null;
  const rawArguments = isRecord(value.rawArguments) ? value.rawArguments : null;
  const displayArguments = isRecord(value.arguments) ? value.arguments : {};
  return {
    id: value.id,
    name: value.name,
    arguments: preferRawArguments && rawArguments ? rawArguments : displayArguments,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
