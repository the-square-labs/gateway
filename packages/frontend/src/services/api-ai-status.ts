import type {
  PublicStatusPageDto,
  StatusPageConfig,
  StatusPageIncident,
  StatusPageIncidentUpdate,
  StatusPageIncidentUpdateStatus,
  StatusPageProxyTemplateOption,
  StatusPageServiceItem,
  StatusPageSourceType,
} from "@/types";
import type {
  AIContextEstimate,
  AIMessage,
  AIMessageAttachment,
  AIPlanStatus,
  AIRunStatus,
  AISandboxArtifactPage,
  AISandboxJob,
  AISandboxOutput,
  AISandboxStatus,
  ChatMessage,
  PageContext,
} from "@/types/ai";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withAIStatusApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class AIStatusApiClient extends Base {
    async getAIStatus(): Promise<import("@/types/ai").AIProviderStatus> {
      return this.request<import("@/types/ai").AIProviderStatus>("/ai/status");
    }

    async getAIConfig(): Promise<Record<string, unknown>> {
      const res = await this.request<{ data: Record<string, unknown> }>("/ai/config");
      return res.data;
    }

    async updateAIConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
      const res = await this.request<{ data: Record<string, unknown> }>("/ai/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      return res.data;
    }

    async listAISkills(): Promise<import("@/types/ai").AIAgentSkill[]> {
      const res = await this.request<{ data: import("@/types/ai").AIAgentSkill[] }>("/ai/skills");
      return res.data;
    }

    async createAISkill(
      input: import("@/types/ai").AIUserSkillInput
    ): Promise<import("@/types/ai").AIAgentSkill> {
      const res = await this.request<{ data: import("@/types/ai").AIAgentSkill }>("/ai/skills", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return res.data;
    }

    async updateAISkill(
      id: string,
      input: Partial<import("@/types/ai").AIUserSkillInput>
    ): Promise<import("@/types/ai").AIAgentSkill> {
      const res = await this.request<{ data: import("@/types/ai").AIAgentSkill }>(
        `/ai/skills/${id}`,
        { method: "PATCH", body: JSON.stringify(input) }
      );
      return res.data;
    }

    async deleteAISkill(id: string): Promise<void> {
      await this.request(`/ai/skills/${id}`, { method: "DELETE" });
    }

    async getAITools(): Promise<
      Record<
        string,
        Array<{
          name: string;
          displayName: string;
          displayDescription: string;
          destructive: boolean;
          requiredScope: string;
        }>
      >
    > {
      const res = await this.request<{
        data: Record<
          string,
          Array<{
            name: string;
            displayName: string;
            displayDescription: string;
            destructive: boolean;
            requiredScope: string;
          }>
        >;
      }>("/ai/tools");
      return res.data;
    }

    async getAIContextEstimate(input?: {
      messages?: ChatMessage[];
      context?: PageContext;
      conversationId?: string | null;
      model?: string;
      reasoningEffort?: string;
    }): Promise<AIContextEstimate> {
      const res = await this.request<{ data: AIContextEstimate }>("/ai/context-estimate", {
        method: "POST",
        body: JSON.stringify({
          messages: input?.messages,
          context: input?.context,
          conversationId: input?.conversationId ?? undefined,
          model: input?.model,
          reasoningEffort: input?.reasoningEffort,
        }),
      });
      return res.data;
    }

    async listAIConversations(): Promise<
      Array<{
        id: string;
        title: string;
        createdAt: string;
        updatedAt: string;
        lastUserMessageAt: string | null;
        messageCount: number;
        folderId: string | null;
        status: "active" | "ended" | "context_blocked";
        blockReason: string | null;
        activeRunStatus: AIRunStatus | null;
        planStatus: AIPlanStatus | null;
      }>
    > {
      const res = await this.request<{
        data: Array<{
          id: string;
          title: string;
          createdAt: string;
          updatedAt: string;
          lastUserMessageAt: string | null;
          messageCount: number;
          folderId: string | null;
          status: "active" | "ended" | "context_blocked";
          blockReason: string | null;
          activeRunStatus: AIRunStatus | null;
          planStatus: AIPlanStatus | null;
        }>;
      }>("/ai/conversations");
      return res.data;
    }

    async listAIConversationFolders(): Promise<
      Array<{
        id: string;
        name: string;
        description: string;
        sortOrder: number;
        createdAt: string;
        updatedAt: string;
      }>
    > {
      const res = await this.request<{
        data: Array<{
          id: string;
          name: string;
          description: string;
          sortOrder: number;
          createdAt: string;
          updatedAt: string;
        }>;
      }>("/ai/conversation-folders");
      return res.data;
    }

    async createAIConversationFolder(data: { name: string; description?: string }): Promise<{
      id: string;
      name: string;
      description: string;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
    }> {
      const res = await this.request<{
        data: {
          id: string;
          name: string;
          description: string;
          sortOrder: number;
          createdAt: string;
          updatedAt: string;
        };
      }>("/ai/conversation-folders", {
        method: "POST",
        body: JSON.stringify(data),
      });
      return res.data;
    }

    async updateAIConversationFolder(
      id: string,
      data: { name?: string; description?: string }
    ): Promise<{
      id: string;
      name: string;
      description: string;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
    }> {
      const res = await this.request<{
        data: {
          id: string;
          name: string;
          description: string;
          sortOrder: number;
          createdAt: string;
          updatedAt: string;
        };
      }>(`/ai/conversation-folders/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      return res.data;
    }

    async deleteAIConversationFolder(id: string): Promise<void> {
      await this.request(`/ai/conversation-folders/${id}`, { method: "DELETE" });
    }

    async reorderAIConversationFolders(items: Array<{ id: string; sortOrder: number }>): Promise<
      Array<{
        id: string;
        name: string;
        description: string;
        sortOrder: number;
        createdAt: string;
        updatedAt: string;
      }>
    > {
      const res = await this.request<{
        data: Array<{
          id: string;
          name: string;
          description: string;
          sortOrder: number;
          createdAt: string;
          updatedAt: string;
        }>;
      }>("/ai/conversation-folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
      return res.data;
    }

    async moveAIConversationsToFolder(
      conversationIds: string[],
      folderId: string | null
    ): Promise<{ moved: number }> {
      const res = await this.request<{ data: { moved: number } }>(
        "/ai/conversation-folders/move-conversations",
        {
          method: "PUT",
          body: JSON.stringify({ conversationIds, folderId }),
        }
      );
      return res.data;
    }

    async getAIConversation(id: string): Promise<{
      id: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      lastUserMessageAt: string | null;
      messageCount: number;
      folderId: string | null;
      status: "active" | "ended" | "context_blocked";
      blockReason: string | null;
      activeRunStatus: AIRunStatus | null;
      messages: AIMessage[];
      model: string | null;
      reasoningEffort: string | null;
      lastContext: PageContext | null;
      discoveredToolsets: string[];
      checkpoint: Record<string, unknown> | null;
    }> {
      const res = await this.request<{
        data: {
          id: string;
          title: string;
          createdAt: string;
          updatedAt: string;
          lastUserMessageAt: string | null;
          messageCount: number;
          folderId: string | null;
          status: "active" | "ended" | "context_blocked";
          blockReason: string | null;
          activeRunStatus: AIRunStatus | null;
          messages: AIMessage[];
          model: string | null;
          reasoningEffort: string | null;
          lastContext: PageContext | null;
          discoveredToolsets: string[];
          checkpoint: Record<string, unknown> | null;
        };
      }>(`/ai/conversations/${id}`);
      return res.data;
    }

    async updateAIConversation(
      id: string,
      data: { title: string }
    ): Promise<{
      id: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      lastUserMessageAt: string | null;
      messageCount: number;
      folderId: string | null;
      status: "active" | "ended" | "context_blocked";
      blockReason: string | null;
      activeRunStatus: AIRunStatus | null;
      messages: AIMessage[];
      model: string | null;
      reasoningEffort: string | null;
      lastContext: PageContext | null;
      discoveredToolsets: string[];
      checkpoint: Record<string, unknown> | null;
    }> {
      const res = await this.request<{
        data: {
          id: string;
          title: string;
          createdAt: string;
          updatedAt: string;
          lastUserMessageAt: string | null;
          messageCount: number;
          folderId: string | null;
          status: "active" | "ended" | "context_blocked";
          blockReason: string | null;
          activeRunStatus: AIRunStatus | null;
          messages: AIMessage[];
          model: string | null;
          reasoningEffort: string | null;
          lastContext: PageContext | null;
          discoveredToolsets: string[];
          checkpoint: Record<string, unknown> | null;
        };
      }>(`/ai/conversations/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      return res.data;
    }

    async updateAIConversationProvider(
      id: string,
      data: { model: string; reasoningEffort: string | null }
    ): Promise<{
      id: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      lastUserMessageAt: string | null;
      messageCount: number;
      folderId: string | null;
      status: "active" | "ended" | "context_blocked";
      blockReason: string | null;
      activeRunStatus: AIRunStatus | null;
      messages: AIMessage[];
      model: string | null;
      reasoningEffort: string | null;
      lastContext: PageContext | null;
      discoveredToolsets: string[];
      checkpoint: Record<string, unknown> | null;
    }> {
      const res = await this.request<{
        data: {
          id: string;
          title: string;
          createdAt: string;
          updatedAt: string;
          lastUserMessageAt: string | null;
          messageCount: number;
          folderId: string | null;
          status: "active" | "ended" | "context_blocked";
          blockReason: string | null;
          activeRunStatus: AIRunStatus | null;
          messages: AIMessage[];
          model: string | null;
          reasoningEffort: string | null;
          lastContext: PageContext | null;
          discoveredToolsets: string[];
          checkpoint: Record<string, unknown> | null;
        };
      }>(`/ai/conversations/${id}/provider`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      return res.data;
    }

    async deleteAIConversation(id: string): Promise<void> {
      await this.request(`/ai/conversations/${id}`, { method: "DELETE" });
    }

    async rollbackAIConversationToMessage(
      id: string,
      messageId: string,
      activeRunId?: string | null
    ): Promise<{
      message: AIMessage;
      conversation: {
        id: string;
        title: string;
        createdAt: string;
        updatedAt: string;
        lastUserMessageAt: string | null;
        messageCount: number;
        folderId: string | null;
        status: "active" | "ended" | "context_blocked";
        blockReason: string | null;
        activeRunStatus: AIRunStatus | null;
        messages: AIMessage[];
        model: string | null;
        reasoningEffort: string | null;
        lastContext: PageContext | null;
        discoveredToolsets: string[];
        checkpoint: Record<string, unknown> | null;
      };
    }> {
      const res = await this.request<{
        data: {
          message: AIMessage;
          conversation: {
            id: string;
            title: string;
            createdAt: string;
            updatedAt: string;
            lastUserMessageAt: string | null;
            messageCount: number;
            folderId: string | null;
            status: "active" | "ended" | "context_blocked";
            blockReason: string | null;
            activeRunStatus: AIRunStatus | null;
            messages: AIMessage[];
            model: string | null;
            reasoningEffort: string | null;
            lastContext: PageContext | null;
            discoveredToolsets: string[];
            checkpoint: Record<string, unknown> | null;
          };
        };
      }>(`/ai/conversations/${id}/rollback`, {
        method: "POST",
        body: JSON.stringify({
          messageId,
          ...(activeRunId ? { activeRunId } : {}),
        }),
      });
      return res.data;
    }

    async getAISandboxStatus(): Promise<AISandboxStatus> {
      const res = await this.request<{ data: AISandboxStatus }>("/ai/sandbox/status");
      return res.data;
    }

    async listAISandboxJobs(
      options: { activeOnly?: boolean; limit?: number; status?: AISandboxJob["status"] } = {}
    ): Promise<AISandboxJob[]> {
      const params = new URLSearchParams();
      if (options.activeOnly !== undefined) params.set("activeOnly", String(options.activeOnly));
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (options.status !== undefined) params.set("status", options.status);
      const query = params.toString();
      const res = await this.request<{ data: AISandboxJob[] }>(
        `/ai/sandbox/jobs${query ? `?${query}` : ""}`
      );
      return res.data;
    }

    async killAISandboxJob(id: string): Promise<unknown> {
      const res = await this.request<{ data: unknown }>(`/ai/sandbox/jobs/${id}/kill`, {
        method: "POST",
      });
      return res.data;
    }

    async getAISandboxJobOutput(id: string, tail = 200): Promise<AISandboxOutput> {
      const params = new URLSearchParams({ tail: String(tail) });
      const res = await this.request<{ data: AISandboxOutput }>(
        `/ai/sandbox/jobs/${id}/output?${params}`
      );
      return res.data;
    }

    async listAISandboxArtifacts(
      options: { page?: number; limit?: number } = {}
    ): Promise<AISandboxArtifactPage> {
      const params = new URLSearchParams();
      if (options.page !== undefined) params.set("page", String(options.page));
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      const query = params.toString();
      return this.request<AISandboxArtifactPage>(
        `/ai/sandbox/artifacts${query ? `?${query}` : ""}`
      );
    }

    async deleteAISandboxArtifact(id: string): Promise<void> {
      await this.request(`/ai/sandbox/artifacts/${id}`, { method: "DELETE" });
    }

    async uploadAIChatArtifact(
      file: File,
      conversationId?: string | null
    ): Promise<AIMessageAttachment> {
      const body = new FormData();
      body.append("file", file);
      if (conversationId) body.append("conversationId", conversationId);
      const res = await this.request<{ data: AIMessageAttachment }>("/ai/sandbox/artifacts", {
        method: "POST",
        body,
      });
      return res.data;
    }

    // ── Status Page ─────────────────────────────────────────────────

    async getStatusPageSettings(): Promise<StatusPageConfig> {
      return this.unwrapData(this.request<{ data: StatusPageConfig }>("/status-page/settings"));
    }

    async updateStatusPageSettings(data: Partial<StatusPageConfig>): Promise<StatusPageConfig> {
      return this.unwrapData(
        this.request<{ data: StatusPageConfig }>("/status-page/settings", {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async listStatusPageProxyTemplates(): Promise<StatusPageProxyTemplateOption[]> {
      return this.unwrapData(
        this.request<{ data: StatusPageProxyTemplateOption[] }>("/status-page/proxy-templates")
      );
    }

    async listStatusPageServices(): Promise<StatusPageServiceItem[]> {
      return this.unwrapData(
        this.request<{ data: StatusPageServiceItem[] }>("/status-page/services")
      );
    }

    async createStatusPageService(data: {
      sourceType: StatusPageSourceType;
      sourceId: string;
      publicName: string;
      publicDescription?: string | null;
      publicGroup?: string | null;
      sortOrder?: number;
      enabled?: boolean;
      createThresholdSeconds?: number;
      resolveThresholdSeconds?: number;
    }): Promise<StatusPageServiceItem> {
      return this.unwrapData(
        this.request<{ data: StatusPageServiceItem }>("/status-page/services", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateStatusPageService(
      id: string,
      data: Partial<Omit<StatusPageServiceItem, "id" | "sourceType" | "sourceId">>
    ): Promise<StatusPageServiceItem> {
      return this.unwrapData(
        this.request<{ data: StatusPageServiceItem }>(`/status-page/services/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async reorderStatusPageServices(serviceIds: string[]): Promise<StatusPageServiceItem[]> {
      return this.unwrapData(
        this.request<{ data: StatusPageServiceItem[] }>("/status-page/services/reorder", {
          method: "PUT",
          body: JSON.stringify({ serviceIds }),
        })
      );
    }

    async deleteStatusPageService(id: string): Promise<void> {
      await this.request<void>(`/status-page/services/${id}`, { method: "DELETE" });
    }

    async listStatusPageIncidents(params?: {
      status?: "active" | "resolved" | "all";
      limit?: number;
      offset?: number;
    }): Promise<StatusPageIncident[]> {
      const searchParams = new URLSearchParams();
      if (params?.status) searchParams.set("status", params.status);
      if (params?.limit) searchParams.set("limit", String(params.limit));
      if (params?.offset !== undefined) searchParams.set("offset", String(params.offset));
      const query = searchParams.toString();
      return this.unwrapData(
        this.request<{ data: StatusPageIncident[] }>(
          `/status-page/incidents${query ? `?${query}` : ""}`
        )
      );
    }

    async createStatusPageIncident(data: {
      title: string;
      message: string;
      severity: "info" | "warning" | "critical";
      affectedServiceIds: string[];
    }): Promise<StatusPageIncident> {
      return this.unwrapData(
        this.request<{ data: StatusPageIncident }>("/status-page/incidents", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateStatusPageIncident(
      id: string,
      data: Partial<
        Pick<
          StatusPageIncident,
          "title" | "message" | "severity" | "affectedServiceIds" | "status" | "autoManaged"
        >
      >
    ): Promise<StatusPageIncident> {
      return this.unwrapData(
        this.request<{ data: StatusPageIncident }>(`/status-page/incidents/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteStatusPageIncident(id: string): Promise<void> {
      await this.request<void>(`/status-page/incidents/${id}`, { method: "DELETE" });
    }

    async resolveStatusPageIncident(id: string): Promise<StatusPageIncident> {
      return this.unwrapData(
        this.request<{ data: StatusPageIncident }>(`/status-page/incidents/${id}/resolve`, {
          method: "POST",
        })
      );
    }

    async promoteStatusPageIncident(id: string): Promise<StatusPageIncident> {
      return this.unwrapData(
        this.request<{ data: StatusPageIncident }>(`/status-page/incidents/${id}/promote`, {
          method: "POST",
        })
      );
    }

    async createStatusPageIncidentUpdate(
      id: string,
      data: { message: string; status?: StatusPageIncidentUpdateStatus }
    ): Promise<StatusPageIncidentUpdate> {
      const update = await this.unwrapData(
        this.request<{ data: StatusPageIncidentUpdate }>(`/status-page/incidents/${id}/updates`, {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
      this.invalidateCache("req:/api/status-page/incidents");
      return update;
    }

    async getStatusPagePreview(): Promise<PublicStatusPageDto> {
      return this.unwrapData(this.request<{ data: PublicStatusPageDto }>("/status-page/preview"));
    }

    // ── Pages ──────────────────────────────────────────────────────
  };
}
