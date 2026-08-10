export function aiConversationRoute(conversationId: string): string {
  return `/ai/chats/${encodeURIComponent(conversationId)}`;
}
