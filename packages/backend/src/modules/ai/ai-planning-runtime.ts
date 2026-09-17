import type { User } from '@/types.js';
import type { AIPlanRuntimeSnapshot, AIToolDefinition } from './ai.types.js';
import type { AIPlanService } from './ai-plan.service.js';

/** Paid policy hooks; DTOs and the Community chat remain in the host. */
export interface AIPlanningRuntime {
  systemInstructions: string;
  executeTool(
    service: AIPlanService | undefined,
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    conversationId?: string
  ): Promise<unknown>;
  isToolNameAllowedForPlanState(toolName: string, status: AIPlanRuntimeSnapshot['status'] | null): boolean;
  isToolAllowedForPlanState(
    tool: AIToolDefinition,
    status: AIPlanRuntimeSnapshot['status'] | null,
    args?: Record<string, unknown>
  ): boolean;
  shouldEndRunAfterPlanTool(toolName: string, result: unknown, error: string | undefined): boolean;
  buildPlanRuntimePrompt(plan: AIPlanRuntimeSnapshot): string;
}
