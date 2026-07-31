import type { AIConversationStatus, AIMessage, AIRunStatus, PageContext } from "@/types/ai";
import { api } from "./api";

export interface SavedAIConversation {
  id: string;
  title: string;
  messages: AIMessage[];
  model?: string | null;
  reasoningEffort?: string | null;
  lastContext: PageContext | null;
  createdAt: string;
  updatedAt: string;
  lastUserMessageAt: string | null;
  folderId: string | null;
  status: AIConversationStatus;
  blockReason: string | null;
  activeRunStatus: AIRunStatus | null;
}

export interface AIConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastUserMessageAt: string | null;
  folderId: string | null;
  messageCount: number;
  status: AIConversationStatus;
  blockReason: string | null;
  activeRunStatus: AIRunStatus | null;
}

export interface AIConversationFolder {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export async function getConversation(id: string): Promise<SavedAIConversation> {
  const conversation = await api.getAIConversation(id);
  return {
    id: conversation.id,
    title: conversation.title,
    messages: conversation.messages,
    model: conversation.model,
    reasoningEffort: conversation.reasoningEffort,
    lastContext: conversation.lastContext,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastUserMessageAt: conversation.lastUserMessageAt,
    folderId: conversation.folderId,
    status: conversation.status,
    blockReason: conversation.blockReason,
    activeRunStatus: conversation.activeRunStatus,
  };
}

export async function listConversations(): Promise<AIConversationSummary[]> {
  const conversations = await api.listAIConversations();
  return conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastUserMessageAt: conversation.lastUserMessageAt,
    folderId: conversation.folderId,
    messageCount: conversation.messageCount,
    status: conversation.status,
    blockReason: conversation.blockReason,
    activeRunStatus: conversation.activeRunStatus,
  }));
}

export async function deleteConversation(id: string): Promise<void> {
  await api.deleteAIConversation(id);
}

export async function renameConversation(id: string, title: string): Promise<SavedAIConversation> {
  const conversation = await api.updateAIConversation(id, { title });
  return {
    id: conversation.id,
    title: conversation.title,
    messages: conversation.messages,
    model: conversation.model,
    reasoningEffort: conversation.reasoningEffort,
    lastContext: conversation.lastContext,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastUserMessageAt: conversation.lastUserMessageAt,
    folderId: conversation.folderId,
    status: conversation.status,
    blockReason: conversation.blockReason,
    activeRunStatus: conversation.activeRunStatus,
  };
}

export async function updateConversationProvider(
  id: string,
  input: { model: string; reasoningEffort: string | null }
): Promise<SavedAIConversation> {
  const conversation = await api.updateAIConversationProvider(id, input);
  return {
    id: conversation.id,
    title: conversation.title,
    messages: conversation.messages,
    model: conversation.model,
    reasoningEffort: conversation.reasoningEffort,
    lastContext: conversation.lastContext,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastUserMessageAt: conversation.lastUserMessageAt,
    folderId: conversation.folderId,
    status: conversation.status,
    blockReason: conversation.blockReason,
    activeRunStatus: conversation.activeRunStatus,
  };
}

export async function rollbackConversationToMessage(
  id: string,
  messageId: string,
  activeRunId?: string | null
): Promise<{ message: AIMessage; conversation: SavedAIConversation }> {
  const result = await api.rollbackAIConversationToMessage(id, messageId, activeRunId);
  return {
    message: result.message,
    conversation: {
      id: result.conversation.id,
      title: result.conversation.title,
      messages: result.conversation.messages,
      model: result.conversation.model,
      reasoningEffort: result.conversation.reasoningEffort,
      lastContext: result.conversation.lastContext,
      createdAt: result.conversation.createdAt,
      updatedAt: result.conversation.updatedAt,
      lastUserMessageAt: result.conversation.lastUserMessageAt,
      folderId: result.conversation.folderId,
      status: result.conversation.status,
      blockReason: result.conversation.blockReason,
      activeRunStatus: result.conversation.activeRunStatus,
    },
  };
}

export async function listConversationFolders(): Promise<AIConversationFolder[]> {
  return api.listAIConversationFolders();
}

export async function createConversationFolder(input: {
  name: string;
  description?: string;
}): Promise<AIConversationFolder> {
  return api.createAIConversationFolder(input);
}

export async function updateConversationFolder(
  id: string,
  input: { name?: string; description?: string }
): Promise<AIConversationFolder> {
  return api.updateAIConversationFolder(id, input);
}

export async function deleteConversationFolder(id: string): Promise<void> {
  await api.deleteAIConversationFolder(id);
}

export async function reorderConversationFolders(
  items: Array<{ id: string; sortOrder: number }>
): Promise<AIConversationFolder[]> {
  return api.reorderAIConversationFolders(items);
}

export async function moveConversationsToFolder(
  conversationIds: string[],
  folderId: string | null
): Promise<void> {
  await api.moveAIConversationsToFolder(conversationIds, folderId);
}
