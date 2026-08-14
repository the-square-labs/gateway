import { type ComponentProps, Fragment } from "react";
import type { AIMessage, AIPlanRuntimeSnapshot } from "@/types/ai";
import { AIPlanBlock } from "./AIComposer";
import { AIMessageList } from "./AIMessageList";

type AIMessageListProps = ComponentProps<typeof AIMessageList>;

export function getPlanInsertionIndex(messages: AIMessage[], plan: AIPlanRuntimeSnapshot): number {
  const anchorAt = plan.timelineAnchorAt ?? plan.publishedAt;
  const publishedAt = anchorAt ? new Date(anchorAt).getTime() : Number.NaN;
  if (!Number.isFinite(publishedAt)) return messages.length;

  const firstLaterMessage = messages.findIndex((message) => {
    if (!message.createdAt) return false;
    const messageCreatedAt = new Date(message.createdAt).getTime();
    return Number.isFinite(messageCreatedAt) && messageCreatedAt > publishedAt;
  });
  return firstLaterMessage === -1 ? messages.length : firstLaterMessage;
}

export function AIPlanTimeline({
  messages,
  plans,
  isStreaming = false,
  ...messageListProps
}: Omit<AIMessageListProps, "messages"> & {
  messages: AIMessage[];
  plans: AIPlanRuntimeSnapshot[];
}) {
  const publishedPlans = plans
    .filter((plan) => plan.revisionId && (plan.timelineAnchorAt ?? plan.publishedAt))
    .sort((left, right) => {
      const leftTime = new Date(
        left.timelineAnchorAt ?? left.publishedAt ?? left.createdAt
      ).getTime();
      const rightTime = new Date(
        right.timelineAnchorAt ?? right.publishedAt ?? right.createdAt
      ).getTime();
      return leftTime - rightTime;
    });
  if (publishedPlans.length === 0) {
    return <AIMessageList {...messageListProps} messages={messages} isStreaming={isStreaming} />;
  }

  let messageCursor = 0;

  return (
    <>
      {publishedPlans.map((plan, planIndex) => {
        const insertionIndex = Math.max(messageCursor, getPlanInsertionIndex(messages, plan));
        const precedingMessages = messages.slice(messageCursor, insertionIndex);
        messageCursor = insertionIndex;
        return (
          <Fragment key={plan.revisionId ?? plan.id}>
            {precedingMessages.length > 0 && (
              <AIMessageList
                {...messageListProps}
                messages={precedingMessages}
                isStreaming={false}
              />
            )}
            <AIPlanBlock
              plan={plan}
              collapsed={publishedPlans.some(
                (candidate, candidateIndex) =>
                  candidateIndex > planIndex && candidate.id === plan.id
              )}
            />
          </Fragment>
        );
      })}
      {messageCursor < messages.length && (
        <AIMessageList
          {...messageListProps}
          messages={messages.slice(messageCursor)}
          isStreaming={isStreaming}
        />
      )}
    </>
  );
}
