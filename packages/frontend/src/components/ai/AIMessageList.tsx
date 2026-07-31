import type { AIMessageAttachment, AIMessage as AIMessageType } from "@/types/ai";
import { AIMessage } from "./AIMessage";

interface AIMessageListProps {
  messages: AIMessageType[];
  assistantMaxWidthClass?: string;
  onApprove?: (toolCallId: string) => void;
  onReject?: (toolCallId: string) => void;
  onAnswer?: (toolCallId: string, answer: string) => void;
  onEditUserMessage?: (
    messageId: string,
    content: string,
    attachments: AIMessageAttachment[]
  ) => void;
  onRetryUserMessage?: (messageId: string) => void;
  retryDisabled?: boolean;
  editUserMessageDisabled?: boolean;
}

export function AIMessageList({
  messages,
  assistantMaxWidthClass,
  onApprove,
  onReject,
  onAnswer,
  onEditUserMessage,
  onRetryUserMessage,
  retryDisabled,
  editUserMessageDisabled,
}: AIMessageListProps) {
  const visibleMessages = collapseConsecutiveModelChanges(messages);
  const groups = groupAssistantTurns(visibleMessages);
  const retryTargets = buildRetryTargets(visibleMessages);

  return (
    <>
      {groups.map((group) =>
        group.length === 1 ? (
          <AIMessage
            key={messageKey(group[0], 0)}
            message={group[0]}
            assistantMaxWidthClass={assistantMaxWidthClass}
            onApprove={onApprove}
            onReject={onReject}
            onAnswer={onAnswer}
            onEditUserMessage={onEditUserMessage}
            onRetry={
              onRetryUserMessage && retryTargets.has(group[0])
                ? () => onRetryUserMessage(retryTargets.get(group[0])!)
                : undefined
            }
            retryDisabled={retryDisabled}
            editUserMessageDisabled={editUserMessageDisabled}
          />
        ) : (
          <div key={group.map((message) => message.id).join(":")} className="space-y-1">
            {group.map((message, index) => (
              <AIMessage
                key={messageKey(message, index)}
                message={message}
                assistantMaxWidthClass={assistantMaxWidthClass}
                onApprove={onApprove}
                onReject={onReject}
                onAnswer={onAnswer}
                onEditUserMessage={onEditUserMessage}
                onRetry={
                  onRetryUserMessage && retryTargets.has(message)
                    ? () => onRetryUserMessage(retryTargets.get(message)!)
                    : undefined
                }
                retryDisabled={retryDisabled}
                editUserMessageDisabled={editUserMessageDisabled}
              />
            ))}
          </div>
        )
      )}
    </>
  );
}

function collapseConsecutiveModelChanges(messages: AIMessageType[]): AIMessageType[] {
  return messages.filter((message, index) => {
    if (!message.modelChange) return true;

    let nextIndex = index + 1;
    while (nextIndex < messages.length && messages[nextIndex].conversationStatus) {
      nextIndex += 1;
    }
    if (messages[nextIndex]?.modelChange) return false;

    let firstChange = message.modelChange;
    let previousIndex = index - 1;
    while (previousIndex >= 0) {
      const previousMessage = messages[previousIndex];
      if (previousMessage.conversationStatus) {
        previousIndex -= 1;
        continue;
      }
      if (!previousMessage.modelChange) break;
      firstChange = previousMessage.modelChange;
      previousIndex -= 1;
    }

    if (firstChange.fromModel === message.modelChange.toModel) return false;

    return true;
  });
}

function buildRetryTargets(messages: AIMessageType[]): Map<AIMessageType, string> {
  const targets = new Map<AIMessageType, string>();
  let lastUserMessageId: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      lastUserMessageId = message.id;
      continue;
    }
    if (lastUserMessageId && message.localOnly && /^\s*\*\*Error:\*\*/i.test(message.content)) {
      targets.set(message, lastUserMessageId);
    }
  }
  return targets;
}

function groupAssistantTurns(messages: AIMessageType[]): AIMessageType[][] {
  const groups: AIMessageType[][] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isAssistantToolOnlyMessage(message)) {
      groups.push([message]);
      continue;
    }

    const group = [message];
    while (index + 1 < messages.length && messages[index + 1].role === "assistant") {
      const next = messages[index + 1];
      if (next.conversationStatus) break;
      group.push(next);
      index += 1;
      if (!isAssistantToolOnlyMessage(next)) break;
    }
    groups.push(group);
  }

  return groups;
}

function isAssistantToolOnlyMessage(message: AIMessageType): boolean {
  return (
    message.role === "assistant" &&
    !message.content.trim() &&
    !message.attachments?.length &&
    !!message.toolCalls?.length
  );
}

function messageKey(message: AIMessageType, index: number): string {
  return message.id || `${message.role}-${index}`;
}
