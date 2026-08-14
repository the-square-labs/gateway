import { and, asc, desc, eq, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  aiConversationFolders,
  aiConversationMessages,
  aiConversationSearchDocuments,
  aiConversations,
  aiRunToolCalls,
  type NewAIConversationSearchDocument,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { escapeLike } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { normalizeSearchText, relaxedTokenWindows, trigramSimilarity } from './ai-conversation-search-normalizer.js';

const logger = createChildLogger('AIConversationSearch');

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_READ_LIMIT = 20;
const MAX_READ_LIMIT = 50;
const MAX_SNIPPET_LENGTH = 280;
const MAX_TEXT_LENGTH = 12_000;
const FUZZY_CANDIDATE_LIMIT = 750;
const WINDOW_RADIUS = 1;
const SEARCH_INDEX_INSERT_BATCH_SIZE = 100;
const PROMPT_PROJECT_CHAT_CONTEXT_LIMIT = 3;
const PROMPT_PROJECT_CHAT_CONTEXT_MESSAGE_LIMIT = 4;
const PROMPT_PROJECT_CHAT_CONTEXT_MESSAGE_LENGTH = 500;

export type AIChatSearchScope =
  | { type: 'current_project' }
  | { type: 'project'; projectId: string }
  | { type: 'no_project' }
  | { type: 'all_user_chats' };

export interface SearchChatsInput {
  query: string;
  scope?: AIChatSearchScope;
  limit?: number;
  currentConversationId?: string;
}

export interface FindInChatInput {
  conversationId: string;
  query: string;
  limit?: number;
  currentConversationId?: string;
}

export interface SearchCompactedHistoryInput {
  conversationId: string;
  query: string;
  limit?: number;
}

export interface ReadChatSliceInput {
  conversationId: string;
  mode: 'latest' | 'first' | 'around_message' | 'after' | 'before';
  messageId?: string;
  cursor?: string;
  limit?: number;
  currentConversationId?: string;
}

export interface ListProjectsInput {
  limit?: number;
  cursor?: string;
  currentConversationId?: string;
}

interface DocumentRow {
  id: string;
  conversationId: string;
  projectId: string | null;
  messageId: string | null;
  kind: string;
  role: string | null;
  text: string;
  normalizedText: string;
  tokens: string[];
  createdAt: Date;
  conversationTitle: string;
  conversationCreatedAt: Date;
  conversationUpdatedAt: Date;
}

interface ScoredDocumentRow extends DocumentRow {
  matchedBy: string;
  score: number;
}

interface MessageRow {
  id: string;
  sequence: number;
  role: string;
  content: string;
  uiMessage: Record<string, unknown>;
  toolCalls: unknown[] | null;
  toolName: string | null;
  toolArgsCompact: Record<string, unknown> | null;
  toolResultRaw: unknown;
  toolResultCompact: unknown;
  isSensitive: boolean;
  createdAt: Date;
}

interface ToolCallRow {
  id: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: unknown;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export class AIConversationSearchService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService?: AuditService
  ) {}

  rebuildConversationIndexBestEffort(userId: string, conversationId: string): void {
    void this.rebuildConversationIndex(userId, conversationId).catch((error) => {
      logger.warn('Failed to rebuild AI conversation search index', { conversationId, error });
    });
  }

  async rebuildConversationIndex(userId: string, conversationId: string): Promise<void> {
    const conversation = await this.getOwnedConversation(userId, conversationId);
    if (!conversation) return;
    const [messages, toolCalls] = await Promise.all([
      this.loadMessageRows(conversation.id),
      this.loadToolCallRows(conversation.id),
    ]);
    const documents = buildConversationSearchDocuments({
      userId,
      projectId: conversation.folderId,
      conversationId: conversation.id,
      title: conversation.title,
      messages,
      toolCalls,
    });

    await this.db.transaction(async (tx) => {
      await tx
        .delete(aiConversationSearchDocuments)
        .where(eq(aiConversationSearchDocuments.conversationId, conversation.id));
      for (const chunk of chunks(documents, SEARCH_INDEX_INSERT_BATCH_SIZE)) {
        await tx.insert(aiConversationSearchDocuments).values(chunk);
      }
    });
  }

  async backfillMissingIndexes(userId: string, limit = 200): Promise<number> {
    const conversations = await this.db
      .select({ id: aiConversations.id })
      .from(aiConversations)
      .where(eq(aiConversations.userId, userId))
      .orderBy(desc(aiConversations.updatedAt))
      .limit(limit);
    if (conversations.length === 0) return 0;
    const indexedRows = await this.db
      .selectDistinct({ conversationId: aiConversationSearchDocuments.conversationId })
      .from(aiConversationSearchDocuments)
      .where(
        and(
          eq(aiConversationSearchDocuments.userId, userId),
          inArray(
            aiConversationSearchDocuments.conversationId,
            conversations.map((conversation) => conversation.id)
          )
        )
      );
    const indexed = new Set(indexedRows.map((row) => row.conversationId));
    const missing = conversations
      .map((conversation) => conversation.id)
      .filter((conversationId) => !indexed.has(conversationId));
    for (const conversationId of missing) {
      await this.rebuildConversationIndex(userId, conversationId);
    }
    return missing.length;
  }

  updateConversationProjectIndexBestEffort(userId: string, conversationIds: string[], projectId: string | null): void {
    void this.updateConversationProjectIndex(userId, conversationIds, projectId).catch((error) => {
      logger.warn('Failed to update AI conversation search project index', {
        conversationIds,
        projectId,
        error,
      });
    });
  }

  async updateConversationProjectIndex(
    userId: string,
    conversationIds: string[],
    projectId: string | null
  ): Promise<void> {
    const ids = [...new Set(conversationIds.filter(Boolean))];
    if (ids.length === 0) return;
    await this.db
      .update(aiConversationSearchDocuments)
      .set({ projectId, updatedAt: new Date() })
      .where(
        and(
          eq(aiConversationSearchDocuments.userId, userId),
          inArray(aiConversationSearchDocuments.conversationId, ids)
        )
      );
  }

  async searchChats(userId: string, input: SearchChatsInput) {
    const query = String(input.query ?? '').trim();
    if (!query) throw new AppError(400, 'AI_CHAT_SEARCH_QUERY_REQUIRED', 'query is required');
    await this.backfillMissingIndexes(userId).catch((error) => {
      logger.warn('Failed to backfill AI conversation search indexes', { userId, error });
    });
    const limit = clampLimit(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const currentConversation = input.currentConversationId
      ? await this.getOwnedConversation(userId, input.currentConversationId)
      : null;
    const scope = await this.resolveScope(userId, currentConversation?.id ?? null, input.scope);
    const normalizedQuery = normalizeSearchText(query);
    const tokens = normalizedQuery.tokens;
    const scopeConditions = [
      eq(aiConversationSearchDocuments.userId, userId),
      ...scopeToConditions(scope),
      ...(currentConversation ? [ne(aiConversationSearchDocuments.conversationId, currentConversation.id)] : []),
    ];
    const collected = new Map<string, ScoredDocumentRow>();
    const appliedStrategies: string[] = [];

    const addRows = (rows: ScoredDocumentRow[], strategy: string) => {
      if (rows.length === 0) return;
      appliedStrategies.push(strategy);
      for (const row of rows) {
        const existing = collected.get(row.id);
        if (!existing || row.score > existing.score) collected.set(row.id, row);
      }
    };

    if (normalizedQuery.normalizedText) {
      addRows(
        await this.queryDocuments(
          [...scopeConditions, containsCondition(normalizedQuery.normalizedText)],
          'phrase',
          1,
          limit * 4
        ),
        'phrase'
      );
    }
    if (collected.size < limit && normalizedQuery.normalizedText) {
      addRows(
        await this.queryDocuments(
          [...scopeConditions, ftsCondition(normalizedQuery.normalizedText)],
          'fts',
          0.92,
          limit * 4
        ),
        'fts'
      );
    }
    if (collected.size < limit && tokens.length > 0) {
      addRows(
        await this.queryDocuments([...scopeConditions, tokenAndCondition(tokens)], 'token_and', 0.86, limit * 4),
        'token_and'
      );
    }
    if (collected.size < limit && tokens.length > 0) {
      addRows(
        await this.queryDocuments([...scopeConditions, tokenOrCondition(tokens)], 'token_or', 0.62, limit * 5),
        'token_or'
      );
    }
    const lastToken = tokens.at(-1);
    if (collected.size < limit && lastToken && lastToken.length >= 3) {
      addRows(
        await this.queryDocuments([...scopeConditions, containsCondition(lastToken)], 'prefix', 0.52, limit * 4),
        'prefix'
      );
    }
    if (collected.size < limit && tokens.length > 1) {
      for (const window of relaxedTokenWindows(tokens).slice(1)) {
        if (collected.size >= limit) break;
        addRows(
          await this.queryDocuments([...scopeConditions, tokenAndCondition(window)], 'relaxed', 0.44, limit * 3),
          'relaxed'
        );
      }
    }
    if (collected.size < limit && normalizedQuery.normalizedText.length >= 3) {
      addRows(await this.fuzzyDocuments(scopeConditions, normalizedQuery.normalizedText, limit), 'fuzzy_trigram');
    }

    const grouped = await this.groupConversationMatches([...collected.values()], limit);
    await this.auditRetrieval(userId, {
      action: 'ai.search_chats',
      currentConversationId: currentConversation?.id ?? input.currentConversationId ?? null,
      currentProjectId: currentConversation?.folderId ?? null,
      scope,
      query,
      resultCount: grouped.length,
    });
    return { results: grouped, appliedStrategies: [...new Set(appliedStrategies)] };
  }

  async findInChat(userId: string, input: FindInChatInput) {
    const conversation = await this.requireOwnedConversation(userId, input.conversationId);
    const currentConversation = input.currentConversationId
      ? await this.getOwnedConversation(userId, input.currentConversationId)
      : null;
    const query = String(input.query ?? '').trim();
    if (!query) throw new AppError(400, 'AI_CHAT_SEARCH_QUERY_REQUIRED', 'query is required');
    const limit = clampLimit(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const normalized = normalizeSearchText(query);
    const [messages, toolCalls] = await Promise.all([
      this.loadMessageRows(conversation.id),
      this.loadToolCallRows(conversation.id),
    ]);
    const rows = scoreInMemoryDocuments(
      buildConversationSearchDocuments({
        userId,
        projectId: conversation.folderId,
        conversationId: conversation.id,
        title: conversation.title,
        messages,
        toolCalls,
      }),
      {
        conversationTitle: conversation.title,
        conversationCreatedAt: conversation.createdAt,
        conversationUpdatedAt: conversation.updatedAt,
      },
      normalized,
      limit
    );
    const grouped = await this.groupConversationMatches(rows, 1);
    const result = grouped[0] ?? {
      conversationId: conversation.id,
      projectId: conversation.folderId,
      title: conversation.title,
      lastUserMessageAt: await this.lastUserMessageAt(conversation.id),
      score: 0,
      matches: [],
    };
    await this.auditRetrieval(userId, {
      action: 'ai.find_in_chat',
      currentConversationId: input.currentConversationId ?? null,
      currentProjectId: currentConversation?.folderId ?? null,
      targetConversationId: conversation.id,
      targetProjectId: conversation.folderId,
      query,
      resultCount: result.matches.length,
    });
    return result;
  }

  async searchCompactedHistory(userId: string, input: SearchCompactedHistoryInput) {
    const conversation = await this.requireOwnedConversation(userId, input.conversationId);
    const query = String(input.query ?? '').trim();
    if (!query) throw new AppError(400, 'AI_CHAT_SEARCH_QUERY_REQUIRED', 'query is required');
    const limit = clampLimit(input.limit, 5, 10);
    const messages = await this.loadMessageRows(conversation.id);
    const markerIndex = findLatestCompactMarkerIndex(messages);
    if (markerIndex < 0) {
      return {
        compacted: false,
        results: [],
        nextStep: 'The current conversation has no compacted history. Use the visible conversation context directly.',
      };
    }
    const marker = messages[markerIndex];
    const boundaryId =
      typeof marker.uiMessage.compactBoundaryMessageId === 'string' ? marker.uiMessage.compactBoundaryMessageId : null;
    const boundary = boundaryId ? messages.find((message) => message.id === boundaryId) : null;
    const boundarySequence = boundary?.sequence ?? marker.sequence - 1;
    const historicalMessages = messages.filter(
      (message) =>
        message.sequence <= boundarySequence &&
        (message.role === 'user' || message.role === 'assistant') &&
        message.uiMessage.compactMarker !== true &&
        !message.isSensitive
    );
    const normalized = normalizeSearchText(query);
    const rows = scoreInMemoryDocuments(
      buildConversationSearchDocuments({
        userId,
        projectId: conversation.folderId,
        conversationId: conversation.id,
        title: conversation.title,
        messages: historicalMessages,
        toolCalls: [],
      }),
      {
        conversationTitle: conversation.title,
        conversationCreatedAt: conversation.createdAt,
        conversationUpdatedAt: conversation.updatedAt,
      },
      normalized,
      limit
    );
    const bestByMessage = new Map<string, ScoredDocumentRow>();
    for (const row of rows) {
      if (!row.messageId || row.kind !== 'message') continue;
      const current = bestByMessage.get(row.messageId);
      if (!current || row.score > current.score) bestByMessage.set(row.messageId, row);
    }
    const results = [...bestByMessage.values()]
      .sort((left, right) => right.score - left.score || right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit)
      .map((match) => {
        const index = historicalMessages.findIndex((message) => message.id === match.messageId);
        const message = historicalMessages[index];
        return {
          score: roundScore(match.score),
          matchedBy: match.matchedBy,
          match: toReadableMessage(message),
          context: historicalMessages.slice(Math.max(0, index - 1), index + 2).map(toReadableMessage),
        };
      });
    await this.auditRetrieval(userId, {
      action: 'ai.search_compacted_history',
      currentConversationId: conversation.id,
      currentProjectId: conversation.folderId,
      targetConversationId: conversation.id,
      targetProjectId: conversation.folderId,
      query,
      resultCount: results.length,
    });
    return {
      compacted: true,
      compactEpoch: typeof marker.uiMessage.compactEpoch === 'number' ? marker.uiMessage.compactEpoch : null,
      results,
      nextStep:
        results.length > 0
          ? 'Use only the returned bounded evidence. Search again with a narrower exact term if the needed detail is absent.'
          : 'No exact historical match was found. Try one narrower identifier, error fragment, path, or command.',
    };
  }

  async readChatSlice(userId: string, input: ReadChatSliceInput) {
    const conversation = await this.requireOwnedConversation(userId, input.conversationId);
    const currentConversation = input.currentConversationId
      ? await this.getOwnedConversation(userId, input.currentConversationId)
      : null;
    const limit = clampLimit(input.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    const messages = (await this.loadMessageRows(conversation.id)).filter(isRetrievableMessage);
    const slice = selectMessageSlice(messages, input, limit);
    await this.auditRetrieval(userId, {
      action: 'ai.read_chat_slice',
      currentConversationId: input.currentConversationId ?? null,
      currentProjectId: currentConversation?.folderId ?? null,
      targetConversationId: conversation.id,
      targetProjectId: conversation.folderId,
      resultCount: slice.messages.length,
    });
    return {
      conversationId: conversation.id,
      projectId: conversation.folderId,
      title: conversation.title,
      messages: slice.messages.map(toReadableMessage),
      nextCursor: slice.nextCursor,
      previousCursor: slice.previousCursor,
    };
  }

  async listProjects(userId: string, input: ListProjectsInput = {}) {
    const result = await this.listProjectPointers(userId, input);
    const currentConversation = input.currentConversationId
      ? await this.getOwnedConversation(userId, input.currentConversationId)
      : null;
    await this.auditRetrieval(userId, {
      action: 'ai.list_chat_projects',
      currentConversationId: input.currentConversationId ?? null,
      currentProjectId: currentConversation?.folderId ?? null,
      resultCount: result.projects.length,
    });
    return result;
  }

  async getPromptPointers(
    userId: string,
    conversationId?: string
  ): Promise<{
    availableProjects: Array<{
      projectId: string;
      name: string;
      description: string | null;
      conversationCount: number;
      lastUserMessageAt: string | null;
    }>;
    recentChats: Array<{
      conversationId: string;
      projectId: string | null;
      title: string;
      lastUserMessageAt: string | null;
    }>;
    projectRecentChatContexts: Array<{
      conversationId: string;
      projectId: string;
      title: string;
      lastUserMessageAt: string | null;
      messages: Array<{
        messageId: string;
        role: string;
        createdAt: string;
        content: string;
        toolName: string | null;
      }>;
    }>;
    currentProjectId: string | null;
  }> {
    const currentConversation = conversationId ? await this.getOwnedConversation(userId, conversationId) : null;
    const currentProjectId = currentConversation?.folderId ?? null;
    const projects = await this.listProjectPointers(userId, { limit: 20, currentConversationId: conversationId });
    const recentChats = await this.recentChatsForPrompt(userId, currentProjectId, currentConversation?.id ?? null);
    const projectRecentChatContexts = currentProjectId
      ? await this.projectRecentChatContexts(recentChats.slice(0, PROMPT_PROJECT_CHAT_CONTEXT_LIMIT), currentProjectId)
      : [];
    return {
      availableProjects: projects.projects,
      recentChats,
      projectRecentChatContexts,
      currentProjectId,
    };
  }

  private async resolveScope(
    userId: string,
    currentConversationId: string | null,
    scope: AIChatSearchScope | undefined
  ): Promise<ResolvedScope> {
    if (scope?.type === 'project') {
      const folder = await this.db.query.aiConversationFolders.findFirst({
        where: and(eq(aiConversationFolders.userId, userId), eq(aiConversationFolders.id, scope.projectId)),
      });
      if (!folder) throw new AppError(404, 'AI_PROJECT_NOT_FOUND', 'AI conversation project not found');
      return { type: 'project', projectId: folder.id };
    }
    if (scope?.type === 'no_project') return { type: 'no_project' };
    if (scope?.type === 'all_user_chats') return { type: 'all_user_chats' };

    const current = currentConversationId ? await this.getOwnedConversation(userId, currentConversationId) : null;
    if (current?.folderId) return { type: 'project', projectId: current.folderId };
    return { type: 'no_project' };
  }

  private async listProjectPointers(userId: string, input: ListProjectsInput = {}) {
    const limit = clampLimit(input.limit, 20, 50);
    const offset = decodeCursor(input.cursor);
    const folders = await this.db
      .select()
      .from(aiConversationFolders)
      .where(eq(aiConversationFolders.userId, userId))
      .orderBy(asc(aiConversationFolders.sortOrder), asc(aiConversationFolders.createdAt))
      .limit(limit + 1)
      .offset(offset);
    const page = folders.slice(0, limit);
    const stats = await this.projectStats(
      userId,
      page.map((folder) => folder.id)
    );
    return {
      projects: page.map((folder) => ({
        projectId: folder.id,
        name: folder.name,
        description: folder.description || null,
        conversationCount: stats.get(folder.id)?.conversationCount ?? 0,
        lastUserMessageAt: stats.get(folder.id)?.lastUserMessageAt?.toISOString() ?? null,
      })),
      nextCursor: folders.length > limit ? encodeCursor(offset + limit) : null,
    };
  }

  private async queryDocuments(
    conditions: SQL[],
    matchedBy: string,
    baseScore: number,
    limit: number
  ): Promise<ScoredDocumentRow[]> {
    const rows = await this.selectDocuments(conditions, limit);
    return rows.map((row) => ({ ...row, matchedBy, score: scoreDocument(row, baseScore) }));
  }

  private async fuzzyDocuments(
    conditions: SQL[],
    normalizedQuery: string,
    limit: number
  ): Promise<ScoredDocumentRow[]> {
    const rows = await this.selectDocuments(conditions, FUZZY_CANDIDATE_LIMIT);
    return rows
      .map((row) => ({
        ...row,
        matchedBy: 'fuzzy_trigram',
        score: trigramSimilarity(normalizedQuery, row.normalizedText),
      }))
      .filter((row) => row.score >= 0.22)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit * 3);
  }

  private async selectDocuments(conditions: SQL[], limit: number): Promise<DocumentRow[]> {
    return this.db
      .select({
        id: aiConversationSearchDocuments.id,
        conversationId: aiConversationSearchDocuments.conversationId,
        projectId: aiConversationSearchDocuments.projectId,
        messageId: aiConversationSearchDocuments.messageId,
        kind: aiConversationSearchDocuments.kind,
        role: aiConversationSearchDocuments.role,
        text: aiConversationSearchDocuments.text,
        normalizedText: aiConversationSearchDocuments.normalizedText,
        tokens: aiConversationSearchDocuments.tokens,
        createdAt: aiConversationSearchDocuments.createdAt,
        conversationTitle: aiConversations.title,
        conversationCreatedAt: aiConversations.createdAt,
        conversationUpdatedAt: aiConversations.updatedAt,
      })
      .from(aiConversationSearchDocuments)
      .innerJoin(aiConversations, eq(aiConversations.id, aiConversationSearchDocuments.conversationId))
      .where(and(...conditions))
      .orderBy(desc(aiConversationSearchDocuments.createdAt))
      .limit(limit);
  }

  private async groupConversationMatches(rows: ScoredDocumentRow[], limit: number) {
    const byConversation = new Map<
      string,
      {
        conversationId: string;
        projectId: string | null;
        title: string;
        createdAt: Date;
        updatedAt: Date;
        score: number;
        matches: Array<{
          kind: string;
          messageId: string | null;
          role: string | null;
          createdAt: string;
          snippet: string;
          matchedBy: string;
          score: number;
        }>;
      }
    >();
    for (const row of rows.sort((left, right) => right.score - left.score)) {
      const existing = byConversation.get(row.conversationId) ?? {
        conversationId: row.conversationId,
        projectId: row.projectId,
        title: row.conversationTitle,
        createdAt: row.conversationCreatedAt,
        updatedAt: row.conversationUpdatedAt,
        score: 0,
        matches: [],
      };
      existing.score = Math.max(existing.score, row.score);
      if (existing.matches.length < 3) {
        existing.matches.push({
          kind: row.kind,
          messageId: row.messageId,
          role: row.role,
          createdAt: row.createdAt.toISOString(),
          snippet: snippet(row.text),
          matchedBy: row.matchedBy,
          score: roundScore(row.score),
        });
      }
      byConversation.set(row.conversationId, existing);
    }
    const grouped = [...byConversation.values()]
      .sort((left, right) => right.score - left.score || right.updatedAt.getTime() - left.updatedAt.getTime())
      .slice(0, limit);
    const lastUserByConversation = await this.lastUserMessageAtMany(grouped.map((row) => row.conversationId));
    return grouped.map((row) => ({
      conversationId: row.conversationId,
      projectId: row.projectId,
      title: row.title,
      lastUserMessageAt: lastUserByConversation.get(row.conversationId)?.toISOString() ?? row.createdAt.toISOString(),
      score: roundScore(row.score),
      matches: row.matches,
    }));
  }

  private async recentChatsForPrompt(userId: string, projectId: string | null, excludeConversationId: string | null) {
    const conversations = await this.db
      .select({
        id: aiConversations.id,
        title: aiConversations.title,
        projectId: aiConversations.folderId,
        createdAt: aiConversations.createdAt,
      })
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.userId, userId),
          projectId ? eq(aiConversations.folderId, projectId) : isNull(aiConversations.folderId),
          ...(excludeConversationId ? [ne(aiConversations.id, excludeConversationId)] : [])
        )
      )
      .orderBy(desc(aiConversations.createdAt))
      .limit(50);
    const lastUserByConversation = await this.lastUserMessageAtMany(
      conversations.map((conversation) => conversation.id)
    );
    return conversations
      .map((conversation) => ({
        conversationId: conversation.id,
        projectId: conversation.projectId,
        title: conversation.title,
        lastUserMessageAt:
          lastUserByConversation.get(conversation.id)?.toISOString() ?? conversation.createdAt.toISOString(),
      }))
      .sort((left, right) => Date.parse(right.lastUserMessageAt) - Date.parse(left.lastUserMessageAt))
      .slice(0, 20);
  }

  private async projectRecentChatContexts(
    chats: Array<{
      conversationId: string;
      projectId: string | null;
      title: string;
      lastUserMessageAt: string | null;
    }>,
    projectId: string
  ) {
    const contexts = [];
    for (const chat of chats.slice(0, PROMPT_PROJECT_CHAT_CONTEXT_LIMIT)) {
      if (chat.projectId !== projectId) continue;
      const messages = (await this.loadMessageRows(chat.conversationId))
        .filter(isRetrievableMessage)
        .slice(-PROMPT_PROJECT_CHAT_CONTEXT_MESSAGE_LIMIT)
        .map(toPromptTailMessage);
      if (messages.length === 0) continue;
      contexts.push({
        conversationId: chat.conversationId,
        projectId,
        title: chat.title,
        lastUserMessageAt: chat.lastUserMessageAt,
        messages,
      });
    }
    return contexts;
  }

  private async projectStats(userId: string, projectIds: string[]) {
    const stats = new Map<string, { conversationCount: number; lastUserMessageAt: Date | null }>();
    if (projectIds.length === 0) return stats;
    const conversations = await this.db
      .select({ id: aiConversations.id, projectId: aiConversations.folderId, createdAt: aiConversations.createdAt })
      .from(aiConversations)
      .where(and(eq(aiConversations.userId, userId), inArray(aiConversations.folderId, projectIds)));
    const lastUserByConversation = await this.lastUserMessageAtMany(
      conversations.map((conversation) => conversation.id)
    );
    for (const conversation of conversations) {
      if (!conversation.projectId) continue;
      const existing = stats.get(conversation.projectId) ?? { conversationCount: 0, lastUserMessageAt: null };
      existing.conversationCount += 1;
      const lastUserMessageAt = lastUserByConversation.get(conversation.id) ?? conversation.createdAt;
      if (!existing.lastUserMessageAt || lastUserMessageAt > existing.lastUserMessageAt) {
        existing.lastUserMessageAt = lastUserMessageAt;
      }
      stats.set(conversation.projectId, existing);
    }
    return stats;
  }

  private async lastUserMessageAt(conversationId: string): Promise<string | null> {
    const result = await this.lastUserMessageAtMany([conversationId]);
    return result.get(conversationId)?.toISOString() ?? null;
  }

  private async lastUserMessageAtMany(conversationIds: string[]): Promise<Map<string, Date>> {
    const ids = [...new Set(conversationIds.filter(Boolean))];
    const result = new Map<string, Date>();
    if (ids.length === 0) return result;
    const rows = await this.db
      .select({
        conversationId: aiConversationMessages.conversationId,
        createdAt: aiConversationMessages.createdAt,
      })
      .from(aiConversationMessages)
      .where(and(inArray(aiConversationMessages.conversationId, ids), eq(aiConversationMessages.role, 'user')))
      .orderBy(desc(aiConversationMessages.createdAt));
    for (const row of rows) {
      if (!result.has(row.conversationId)) result.set(row.conversationId, row.createdAt);
    }
    return result;
  }

  private async getOwnedConversation(userId: string, conversationId: string) {
    return this.db.query.aiConversations.findFirst({
      where: and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId)),
    });
  }

  private async requireOwnedConversation(userId: string, conversationId: string) {
    const conversation = await this.getOwnedConversation(userId, conversationId);
    if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
    return conversation;
  }

  private async loadMessageRows(conversationId: string): Promise<MessageRow[]> {
    return this.db
      .select({
        id: aiConversationMessages.id,
        sequence: aiConversationMessages.sequence,
        role: aiConversationMessages.role,
        content: aiConversationMessages.content,
        uiMessage: aiConversationMessages.uiMessage,
        toolCalls: aiConversationMessages.toolCalls,
        toolName: aiConversationMessages.toolName,
        toolArgsCompact: aiConversationMessages.toolArgsCompact,
        toolResultRaw: aiConversationMessages.toolResultRaw,
        toolResultCompact: aiConversationMessages.toolResultCompact,
        isSensitive: aiConversationMessages.isSensitive,
        createdAt: aiConversationMessages.createdAt,
      })
      .from(aiConversationMessages)
      .where(eq(aiConversationMessages.conversationId, conversationId))
      .orderBy(asc(aiConversationMessages.sequence));
  }

  private async loadToolCallRows(conversationId: string): Promise<ToolCallRow[]> {
    return this.db
      .select({
        id: aiRunToolCalls.id,
        toolCallId: aiRunToolCalls.toolCallId,
        toolName: aiRunToolCalls.toolName,
        toolArgs: aiRunToolCalls.toolArgs,
        result: aiRunToolCalls.result,
        error: aiRunToolCalls.error,
        createdAt: aiRunToolCalls.createdAt,
        completedAt: aiRunToolCalls.completedAt,
      })
      .from(aiRunToolCalls)
      .where(eq(aiRunToolCalls.conversationId, conversationId))
      .orderBy(asc(aiRunToolCalls.createdAt));
  }

  private async auditRetrieval(
    userId: string,
    input: {
      action: string;
      currentConversationId?: string | null;
      currentProjectId?: string | null;
      targetConversationId?: string | null;
      targetProjectId?: string | null;
      scope?: unknown;
      query?: string;
      resultCount?: number;
    }
  ): Promise<void> {
    await this.auditService?.log({
      userId,
      action: input.action,
      resourceType: 'ai_conversation_retrieval',
      resourceId: input.targetConversationId ?? input.currentConversationId ?? undefined,
      details: {
        currentConversationId: input.currentConversationId ?? null,
        currentProjectId: input.currentProjectId ?? null,
        targetConversationId: input.targetConversationId ?? null,
        targetProjectId: input.targetProjectId ?? null,
        scope: input.scope ?? null,
        query: input.query ?? null,
        resultCount: input.resultCount ?? null,
      },
    });
  }
}

type ResolvedScope = { type: 'project'; projectId: string } | { type: 'no_project' } | { type: 'all_user_chats' };

function buildConversationSearchDocuments(input: {
  userId: string;
  projectId: string | null;
  conversationId: string;
  title: string;
  messages: MessageRow[];
  toolCalls: ToolCallRow[];
}): NewAIConversationSearchDocument[] {
  const documents: NewAIConversationSearchDocument[] = [];
  pushDocument(documents, input, {
    kind: 'title',
    role: null,
    messageId: null,
    text: input.title,
    createdAt: new Date(),
  });
  for (const message of input.messages) {
    if (!isRetrievableMessage(message)) continue;
    pushDocument(documents, input, {
      kind: 'message',
      role: message.role,
      messageId: message.id,
      text: messageText(message),
      createdAt: message.createdAt,
    });
    const toolText = toolMessageText(message);
    if (toolText) {
      pushDocument(documents, input, {
        kind: message.role === 'tool' ? 'tool_result' : 'tool_call',
        role: message.role,
        messageId: message.id,
        text: toolText,
        createdAt: message.createdAt,
      });
    }
  }
  for (const toolCall of input.toolCalls) {
    const text = [toolCall.toolName, toolCall.toolCallId, toolCall.result || toolCall.error ? 'tool_result' : null]
      .filter(Boolean)
      .join('\n');
    pushDocument(documents, input, {
      kind: toolCall.result || toolCall.error ? 'tool_result' : 'tool_call',
      role: 'tool',
      messageId: null,
      text,
      createdAt: toolCall.completedAt ?? toolCall.createdAt,
    });
  }
  for (let index = 0; index < input.messages.length; index += 1) {
    const windowMessages = input.messages
      .slice(Math.max(0, index - WINDOW_RADIUS), index + WINDOW_RADIUS + 1)
      .filter(isRetrievableMessage);
    const text = windowMessages.map(messageText).filter(Boolean).join('\n');
    if (text) {
      pushDocument(documents, input, {
        kind: 'window',
        role: null,
        messageId: input.messages[index]?.id ?? null,
        text,
        createdAt: input.messages[index]?.createdAt ?? new Date(),
      });
    }
  }
  return documents;
}

function pushDocument(
  documents: NewAIConversationSearchDocument[],
  base: { userId: string; projectId: string | null; conversationId: string },
  input: { kind: string; role: string | null; messageId: string | null; text: string; createdAt: Date }
) {
  const text = truncateText(input.text);
  const normalized = normalizeSearchText(text);
  if (!normalized.normalizedText) return;
  documents.push({
    userId: base.userId,
    projectId: base.projectId,
    conversationId: base.conversationId,
    messageId: input.messageId,
    kind: input.kind,
    role: input.role,
    text,
    normalizedText: normalized.normalizedText,
    tokens: normalized.tokens,
    tokenCount: normalized.tokens.length,
    createdAt: input.createdAt,
    updatedAt: new Date(),
  });
}

function messageText(message: MessageRow): string {
  if (message.role === 'tool') return '';
  const uiContent = typeof message.uiMessage.content === 'string' ? message.uiMessage.content : '';
  return [message.content, uiContent].filter(Boolean).join('\n');
}

function isRetrievableMessage(message: MessageRow): boolean {
  return !message.isSensitive && message.role !== 'system' && message.uiMessage.hiddenSystemEvent !== true;
}

function findLatestCompactMarkerIndex(messages: MessageRow[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.uiMessage.compactMarker === true) return index;
  }
  return -1;
}

function toolMessageText(message: MessageRow): string {
  const parts: string[] = [];
  if (message.toolName) parts.push(message.toolName);
  if (Array.isArray(message.toolCalls)) {
    for (const toolCall of message.toolCalls) {
      if (isRecord(toolCall) && typeof toolCall.name === 'string') parts.push(toolCall.name);
    }
  }
  return parts.filter(Boolean).join('\n');
}

function scopeToConditions(scope: ResolvedScope): SQL[] {
  const conditions: SQL[] = [];
  if (scope.type === 'project') conditions.push(eq(aiConversationSearchDocuments.projectId, scope.projectId));
  if (scope.type === 'no_project') conditions.push(isNull(aiConversationSearchDocuments.projectId));
  return conditions;
}

function containsCondition(value: string): SQL {
  return sql`${aiConversationSearchDocuments.normalizedText} ilike ${`%${escapeLike(value)}%`} escape '\\'`;
}

function ftsCondition(value: string): SQL {
  return sql`to_tsvector('simple', ${aiConversationSearchDocuments.normalizedText}) @@ websearch_to_tsquery('simple', ${value})`;
}

function tokenAndCondition(tokens: string[]): SQL {
  return and(...tokens.map(containsCondition))!;
}

function tokenOrCondition(tokens: string[]): SQL {
  return or(...tokens.map(containsCondition))!;
}

function scoreDocument(row: DocumentRow, baseScore: number): number {
  const kindBoost = row.kind === 'title' ? 0.08 : row.role === 'user' ? 0.04 : 0;
  const recencyBoost = Math.max(0, 0.04 - (Date.now() - row.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 365) / 25);
  return Math.min(1, baseScore + kindBoost + recencyBoost);
}

function selectMessageSlice(messages: MessageRow[], input: ReadChatSliceInput, limit: number) {
  let start = 0;
  if (input.cursor) start = Math.max(0, Number.parseInt(input.cursor, 10) || 0);
  else if (input.mode === 'latest') start = Math.max(0, messages.length - limit);
  else if (input.mode === 'around_message' && input.messageId) {
    const index = messages.findIndex((message) => message.id === input.messageId);
    start = Math.max(0, (index >= 0 ? index : 0) - Math.floor(limit / 2));
  } else if (input.mode === 'after' && input.messageId) {
    const index = messages.findIndex((message) => message.id === input.messageId);
    start = index >= 0 ? index + 1 : 0;
  } else if (input.mode === 'before' && input.messageId) {
    const index = messages.findIndex((message) => message.id === input.messageId);
    start = Math.max(0, (index >= 0 ? index : messages.length) - limit);
  }
  const selected = messages.slice(start, start + limit);
  return {
    messages: selected,
    nextCursor: start + limit < messages.length ? String(start + limit) : null,
    previousCursor: start > 0 ? String(Math.max(0, start - limit)) : null,
  };
}

function toReadableMessage(message: MessageRow) {
  return {
    messageId: message.id,
    role: message.role,
    sequence: message.sequence,
    createdAt: message.createdAt.toISOString(),
    content: truncateText(messageText(message)),
    toolName: message.toolName,
  };
}

function toPromptTailMessage(message: MessageRow) {
  return {
    messageId: message.id,
    role: message.role,
    createdAt: message.createdAt.toISOString(),
    content: truncatePromptTailText(messageText(message)),
    toolName: message.toolName,
  };
}

function truncateText(value: string): string {
  return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)} ...` : value;
}

function snippet(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > MAX_SNIPPET_LENGTH ? `${compact.slice(0, MAX_SNIPPET_LENGTH)}...` : compact;
}

function truncatePromptTailText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > PROMPT_PROJECT_CHAT_CONTEXT_MESSAGE_LENGTH
    ? `${compact.slice(0, PROMPT_PROJECT_CHAT_CONTEXT_MESSAGE_LENGTH)}...`
    : compact;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Math.min(max, Math.max(1, Number.isFinite(parsed) ? Math.trunc(parsed) : fallback));
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function scoreInMemoryDocuments(
  documents: NewAIConversationSearchDocument[],
  conversation: { conversationTitle: string; conversationCreatedAt: Date; conversationUpdatedAt: Date },
  normalizedQuery: { normalizedText: string; tokens: string[] },
  limit: number
): ScoredDocumentRow[] {
  const collected = new Map<string, ScoredDocumentRow>();
  const addMatches = (
    predicate: (document: NewAIConversationSearchDocument) => boolean,
    matchedBy: string,
    score: number
  ) => {
    for (const [index, document] of documents.entries()) {
      if (!predicate(document)) continue;
      const row = toDocumentRow(document, conversation, index, matchedBy, score);
      const existing = collected.get(row.id);
      if (!existing || row.score > existing.score) collected.set(row.id, row);
    }
  };

  if (normalizedQuery.normalizedText) {
    addMatches((document) => document.normalizedText.includes(normalizedQuery.normalizedText), 'phrase', 1);
  }
  if (collected.size < limit && normalizedQuery.tokens.length > 0) {
    addMatches((document) => allTokensMatch(document, normalizedQuery.tokens), 'fts', 0.92);
  }
  if (collected.size < limit && normalizedQuery.tokens.length > 0) {
    addMatches((document) => allTokensMatch(document, normalizedQuery.tokens), 'token_and', 0.86);
  }
  if (collected.size < limit && normalizedQuery.tokens.length > 0) {
    addMatches((document) => someTokenMatches(document, normalizedQuery.tokens), 'token_or', 0.62);
  }
  if (collected.size < limit && normalizedQuery.normalizedText.length >= 3) {
    addMatches(
      (document) => trigramSimilarity(normalizedQuery.normalizedText, document.normalizedText) >= 0.22,
      'fuzzy_trigram',
      0
    );
  }

  return [...collected.values()]
    .map((row) =>
      row.matchedBy === 'fuzzy_trigram'
        ? { ...row, score: trigramSimilarity(normalizedQuery.normalizedText, row.normalizedText) }
        : row
    )
    .sort((left, right) => right.score - left.score || right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, limit * 4);
}

function toDocumentRow(
  document: NewAIConversationSearchDocument,
  conversation: { conversationTitle: string; conversationCreatedAt: Date; conversationUpdatedAt: Date },
  index: number,
  matchedBy: string,
  baseScore: number
): ScoredDocumentRow {
  const createdAt = document.createdAt instanceof Date ? document.createdAt : new Date();
  const row: DocumentRow = {
    id: `${document.kind}:${document.messageId ?? 'conversation'}:${index}`,
    conversationId: document.conversationId,
    projectId: document.projectId ?? null,
    messageId: document.messageId ?? null,
    kind: document.kind,
    role: document.role ?? null,
    text: document.text,
    normalizedText: document.normalizedText,
    tokens: Array.isArray(document.tokens) ? document.tokens : [],
    createdAt,
    conversationTitle: conversation.conversationTitle,
    conversationCreatedAt: conversation.conversationCreatedAt,
    conversationUpdatedAt: conversation.conversationUpdatedAt,
  };
  return { ...row, matchedBy, score: scoreDocument(row, baseScore) };
}

function allTokensMatch(document: NewAIConversationSearchDocument, tokens: string[]): boolean {
  return tokens.every((token) => tokenMatches(document, token));
}

function someTokenMatches(document: NewAIConversationSearchDocument, tokens: string[]): boolean {
  return tokens.some((token) => tokenMatches(document, token));
}

function tokenMatches(document: NewAIConversationSearchDocument, token: string): boolean {
  const tokens = Array.isArray(document.tokens) ? document.tokens : [];
  return tokens.includes(token) || document.normalizedText.includes(token);
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
