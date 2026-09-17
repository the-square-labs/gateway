import { and, asc, desc, eq, inArray, isNotNull, lte, max } from 'drizzle-orm';
import {
  aiConversations,
  aiPlanRevisions,
  aiPlanSteps,
  aiPlans,
  aiRuns,
  sandboxJobs,
  users,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { computeEffectiveUserAccess, fetchGroupScopeMap } from '@/modules/auth/live-session-user.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { registerCommercialAITools } from './ai.tools.js';
import { getAIToolApprovalDecision } from './ai-approval-policy.js';

/** Shared database identities used by the installed AI planning module. */
export const aiCommercialRuntime = {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  max,
  lte,
  aiConversations,
  aiPlanRevisions,
  aiPlanSteps,
  aiPlans,
  aiRuns,
  AppError,
  TokensService,
  sandboxJobs,
  users,
  computeEffectiveUserAccess,
  fetchGroupScopeMap,
  hasScope,
  sandboxLogger: createChildLogger('AISandboxService'),
  registerCommercialAITools,
  getAIToolApprovalDecision,
};
