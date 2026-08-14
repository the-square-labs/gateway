import { and, asc, desc, eq, inArray, isNotNull, max } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import {
  type AIPlan,
  type AIPlanChangeSummary,
  type AIPlanResearchFinding,
  type AIPlanReview,
  type AIPlanStepEvidence,
  type AIPlanStepStatus,
  type AIPlanVerificationCriterion,
  type AIRunPurpose,
  aiConversations,
  aiPlanRevisions,
  aiPlanSteps,
  aiPlans,
  aiRuns,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AIPlanRuntimeSnapshot } from './ai.types.js';

const ACTIVE_PLAN_STATUSES: AIPlan['status'][] = [
  'drafting',
  'validating',
  'awaiting_decision',
  'executing',
  'pause_requested',
  'paused',
  'verifying',
];

export interface AIPlanDraftInput {
  title: string;
  goal: string;
  scope: string[];
  assumptions: string[];
  research: AIPlanResearchFinding[];
  steps: Array<{ title: string; description: string; verification: string }>;
  verification: AIPlanVerificationCriterion[];
  changeSummary?: AIPlanChangeSummary | null;
}

export class AIPlanService {
  constructor(private readonly db: DrizzleClient) {}

  async enterPlan(input: {
    userId: string;
    conversationId: string;
    title?: string;
    model?: string | null;
    reasoningEffort?: string | null;
  }): Promise<AIPlanRuntimeSnapshot> {
    const existing = await this.getActivePlan(input.userId, input.conversationId);
    if (existing) return this.snapshot(existing);

    const [conversation] = await this.db
      .select({ model: aiConversations.model, reasoningEffort: aiConversations.reasoningEffort })
      .from(aiConversations)
      .where(and(eq(aiConversations.id, input.conversationId), eq(aiConversations.userId, input.userId)))
      .limit(1);
    if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');

    const [created] = await this.db
      .insert(aiPlans)
      .values({
        userId: input.userId,
        conversationId: input.conversationId,
        title: cleanOptional(input.title),
        model: cleanOptional(input.model) ?? conversation.model,
        reasoningEffort: cleanOptional(input.reasoningEffort) ?? conversation.reasoningEffort,
      })
      .returning();
    if (!created) throw new AppError(500, 'AI_PLAN_CREATE_FAILED', 'Failed to create AI plan');
    return this.snapshot(created);
  }

  async submitPlan(userId: string, conversationId: string, input: AIPlanDraftInput): Promise<AIPlanRuntimeSnapshot> {
    if (input.steps.length === 0) {
      throw new AppError(400, 'AI_PLAN_STEPS_REQUIRED', 'A plan must contain at least one implementation step');
    }

    const plan = await this.requireActivePlan(userId, conversationId);
    if (plan.status !== 'drafting' && plan.status !== 'paused' && plan.status !== 'awaiting_decision') {
      throw new AppError(409, 'AI_PLAN_NOT_DRAFTING', 'The active plan is not accepting a new draft');
    }

    await this.db.transaction(async (tx) => {
      const [latest] = await tx
        .select({ revision: aiPlanRevisions.revision })
        .from(aiPlanRevisions)
        .where(eq(aiPlanRevisions.planId, plan.id))
        .orderBy(desc(aiPlanRevisions.revision))
        .limit(1);
      const revisionNumber = (latest?.revision ?? 0) + 1;
      const [revision] = await tx
        .insert(aiPlanRevisions)
        .values({
          planId: plan.id,
          revision: revisionNumber,
          status: 'validating',
          goal: input.goal.trim(),
          scope: cleanStrings(input.scope),
          assumptions: cleanStrings(input.assumptions),
          research: input.research,
          verification: input.verification,
          changeSummary: input.changeSummary ?? null,
        })
        .returning();
      if (!revision) throw new AppError(500, 'AI_PLAN_REVISION_CREATE_FAILED', 'Failed to create plan revision');

      await tx.insert(aiPlanSteps).values(
        input.steps.map((step, ordinal) => ({
          revisionId: revision.id,
          ordinal,
          title: step.title.trim(),
          description: step.description.trim(),
          verification: step.verification.trim(),
        }))
      );
      await tx
        .update(aiPlans)
        .set({ status: 'validating', title: input.title.trim(), pauseReason: null, updatedAt: new Date() })
        .where(eq(aiPlans.id, plan.id));
    });

    return this.requireSnapshot(userId, conversationId);
  }

  async submitPlanReview(input: {
    userId: string;
    conversationId: string;
    intentReview: AIPlanReview;
    securityReview: AIPlanReview;
  }): Promise<{ plan: AIPlanRuntimeSnapshot; published: boolean; requiresQuestion: boolean }> {
    const plan = await this.requireActivePlan(input.userId, input.conversationId);
    if (plan.status !== 'validating') {
      throw new AppError(409, 'AI_PLAN_NOT_VALIDATING', 'The active plan is not awaiting validation');
    }

    const passed = input.intentReview.verdict === 'pass' && input.securityReview.verdict === 'pass';
    const findings = [...input.intentReview.findings, ...input.securityReview.findings];
    let requiresQuestion = false;
    await this.db.transaction(async (tx) => {
      const [revision] = await tx
        .select()
        .from(aiPlanRevisions)
        .where(and(eq(aiPlanRevisions.planId, plan.id), eq(aiPlanRevisions.status, 'validating')))
        .orderBy(desc(aiPlanRevisions.revision))
        .limit(1);
      if (!revision || revision.status !== 'validating') {
        throw new AppError(409, 'AI_PLAN_REVISION_NOT_VALIDATING', 'Plan revision is not awaiting validation');
      }
      const previousRejected = await tx
        .select({ id: aiPlanRevisions.id })
        .from(aiPlanRevisions)
        .where(and(eq(aiPlanRevisions.planId, plan.id), eq(aiPlanRevisions.status, 'rejected')));
      const attempts = previousRejected.length + 1;
      requiresQuestion = !passed && attempts >= 3;
      await tx
        .update(aiPlanRevisions)
        .set({
          status: passed ? 'published' : 'rejected',
          intentReview: input.intentReview,
          securityReview: input.securityReview,
          validationAttempts: attempts,
          validatorFindings: findings,
          publishedAt: passed ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(aiPlanRevisions.id, revision.id));
      await tx
        .update(aiPlans)
        .set({
          status: passed ? 'awaiting_decision' : 'drafting',
          pauseReason: passed ? null : requiresQuestion ? 'Plan validation needs user input' : 'Plan requires revision',
          updatedAt: new Date(),
        })
        .where(eq(aiPlans.id, plan.id));
    });

    return {
      plan: await this.requireSnapshot(input.userId, input.conversationId),
      published: passed,
      requiresQuestion,
    };
  }

  async recoverFailedValidation(
    userId: string,
    conversationId: string,
    planId: string,
    reason: string
  ): Promise<boolean> {
    const plan = await this.getActivePlan(userId, conversationId);
    if (!plan || plan.id !== planId || plan.status !== 'validating') return false;
    const failureReason = reason.trim() || 'Plan validation failed';
    await this.db.transaction(async (tx) => {
      await tx
        .update(aiPlanRevisions)
        .set({ status: 'superseded', validatorFindings: [failureReason], updatedAt: new Date() })
        .where(and(eq(aiPlanRevisions.planId, plan.id), eq(aiPlanRevisions.status, 'validating')));
      await tx
        .update(aiPlans)
        .set({ status: 'drafting', pauseReason: failureReason, updatedAt: new Date() })
        .where(and(eq(aiPlans.id, plan.id), eq(aiPlans.status, 'validating')));
    });
    return true;
  }

  async recoverStoppedPlanRun(
    userId: string,
    conversationId: string,
    planId: string,
    purpose: AIRunPurpose,
    reason: string
  ): Promise<boolean> {
    const plan = await this.getActivePlan(userId, conversationId);
    if (!plan || plan.id !== planId) return false;
    const stopReason = reason.trim() || 'Plan run stopped by user';

    if (purpose === 'plan_validation') {
      return this.recoverFailedValidation(userId, conversationId, planId, stopReason);
    }
    if (purpose === 'plan_draft' && plan.status === 'drafting') {
      await this.db
        .update(aiPlans)
        .set({ pauseReason: stopReason, updatedAt: new Date() })
        .where(and(eq(aiPlans.id, plan.id), eq(aiPlans.status, 'drafting')));
      return true;
    }
    if (
      (purpose === 'plan_execution' || purpose === 'plan_verification') &&
      (plan.status === 'executing' || plan.status === 'pause_requested' || plan.status === 'verifying')
    ) {
      if (plan.status === 'pause_requested') {
        await this.completePauseRequest(userId, conversationId);
        return true;
      }
      await this.pause(userId, conversationId, stopReason);
      return true;
    }
    return false;
  }

  async decide(input: {
    userId: string;
    conversationId: string;
    planId: string;
    revisionId: string;
    decision: 'implement' | 'refine' | 'custom';
    customInstruction?: string;
    clientCommandId: string;
  }): Promise<{ plan: AIPlanRuntimeSnapshot; duplicate: boolean }> {
    const existing = await this.db
      .select()
      .from(aiPlanRevisions)
      .where(eq(aiPlanRevisions.decisionClientCommandId, input.clientCommandId))
      .limit(1);
    if (existing[0]) return { plan: await this.requireSnapshot(input.userId, input.conversationId), duplicate: true };

    const plan = await this.requireActivePlan(input.userId, input.conversationId);
    if (plan.id !== input.planId || plan.status !== 'awaiting_decision') {
      throw new AppError(409, 'AI_PLAN_NOT_AWAITING_DECISION', 'The active plan is not awaiting a decision');
    }
    const customInstruction = cleanOptional(input.customInstruction);
    if (input.decision === 'custom' && !customInstruction) {
      throw new AppError(400, 'AI_PLAN_CUSTOM_INSTRUCTION_REQUIRED', 'Custom implementation instruction is required');
    }

    if (input.decision !== 'refine') {
      const snapshot = await this.acceptPublishedRevisionForExecution({
        userId: input.userId,
        conversationId: input.conversationId,
        plan,
        revisionId: input.revisionId,
        decision: input.decision,
        customInstruction: customInstruction ?? undefined,
        clientCommandId: input.clientCommandId,
      });
      return { plan: snapshot, duplicate: false };
    }

    await this.db.transaction(async (tx) => {
      const [revision] = await tx
        .select()
        .from(aiPlanRevisions)
        .where(and(eq(aiPlanRevisions.id, input.revisionId), eq(aiPlanRevisions.planId, plan.id)))
        .limit(1);
      if (!revision || revision.status !== 'published') {
        throw new AppError(409, 'AI_PLAN_REVISION_NOT_PUBLISHED', 'Plan revision is not available for a decision');
      }
    });
    return { plan: await this.requireSnapshot(input.userId, input.conversationId), duplicate: false };
  }

  async startExecution(userId: string, conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    const plan = await this.requireActivePlan(userId, conversationId);
    if (plan.status === 'executing') return this.snapshot(plan);
    if (plan.status !== 'awaiting_decision') {
      throw new AppError(409, 'AI_PLAN_NOT_AWAITING_DECISION', 'No published plan is awaiting execution');
    }
    return this.acceptPublishedRevisionForExecution({
      userId,
      conversationId,
      plan,
      decision: 'implement',
    });
  }

  private async acceptPublishedRevisionForExecution(input: {
    userId: string;
    conversationId: string;
    plan: AIPlan;
    revisionId?: string;
    decision: 'implement' | 'custom';
    customInstruction?: string;
    clientCommandId?: string;
  }): Promise<AIPlanRuntimeSnapshot> {
    await this.db.transaction(async (tx) => {
      const [revision] = await tx
        .select()
        .from(aiPlanRevisions)
        .where(
          input.revisionId
            ? and(
                eq(aiPlanRevisions.id, input.revisionId),
                eq(aiPlanRevisions.planId, input.plan.id),
                eq(aiPlanRevisions.status, 'published')
              )
            : and(eq(aiPlanRevisions.planId, input.plan.id), eq(aiPlanRevisions.status, 'published'))
        )
        .orderBy(desc(aiPlanRevisions.revision))
        .limit(1);
      if (!revision) {
        throw new AppError(409, 'AI_PLAN_REVISION_NOT_PUBLISHED', 'No published plan revision is available');
      }
      const now = new Date();
      await tx
        .update(aiPlanRevisions)
        .set({
          status: 'accepted',
          decision: input.decision,
          customInstruction: input.customInstruction,
          decisionClientCommandId: input.clientCommandId,
          acceptedAt: now,
          decisionAt: now,
          updatedAt: now,
        })
        .where(eq(aiPlanRevisions.id, revision.id));
      await tx
        .update(aiPlans)
        .set({ status: 'executing', activeSince: now, pauseReason: null, noProgressRuns: 0, updatedAt: now })
        .where(eq(aiPlans.id, input.plan.id));
    });
    return this.requireSnapshot(input.userId, input.conversationId);
  }

  async updateStep(input: {
    userId: string;
    conversationId: string;
    status: AIPlanStepStatus;
    evidence?: AIPlanStepEvidence[];
    skipReason?: string;
  }): Promise<AIPlanRuntimeSnapshot & { progressMade: boolean }> {
    const plan = await this.requireActivePlan(input.userId, input.conversationId);
    if (plan.status !== 'executing') {
      throw new AppError(409, 'AI_PLAN_NOT_EXECUTING', 'Plan steps can only be updated during execution');
    }
    if (input.status === 'completed' && (input.evidence?.length ?? 0) === 0) {
      throw new AppError(400, 'AI_PLAN_STEP_EVIDENCE_REQUIRED', 'Completed plan steps require verification evidence');
    }
    if (input.status === 'skipped' && !cleanOptional(input.skipReason)) {
      throw new AppError(400, 'AI_PLAN_STEP_SKIP_REASON_REQUIRED', 'Skipped plan steps require a reason');
    }

    const progressMade = await this.db.transaction(async (tx) => {
      const revision = await requireAcceptedRevision(tx, plan.id);
      const [activeStep] = await tx
        .select()
        .from(aiPlanSteps)
        .where(and(eq(aiPlanSteps.revisionId, revision.id), eq(aiPlanSteps.status, 'in_progress')))
        .orderBy(asc(aiPlanSteps.ordinal))
        .limit(1);
      const [nextStep] =
        input.status === 'in_progress' && !activeStep
          ? await tx
              .select()
              .from(aiPlanSteps)
              .where(and(eq(aiPlanSteps.revisionId, revision.id), eq(aiPlanSteps.status, 'pending')))
              .orderBy(asc(aiPlanSteps.ordinal))
              .limit(1)
          : [];
      const step = activeStep ?? nextStep;
      if (!step) {
        throw new AppError(
          409,
          input.status === 'in_progress' ? 'AI_PLAN_STEP_NOT_AVAILABLE' : 'AI_PLAN_STEP_NOT_ACTIVE',
          input.status === 'in_progress' ? 'No pending plan step is available' : 'No plan step is currently active'
        );
      }
      if ((step.status === 'completed' || step.status === 'skipped') && step.status !== input.status) {
        throw new AppError(409, 'AI_PLAN_STEP_TERMINAL', 'Completed and skipped plan steps cannot be reopened');
      }
      const now = new Date();
      const madeProgress = step.status !== input.status && (input.status === 'completed' || input.status === 'skipped');
      await tx
        .update(aiPlanSteps)
        .set({
          status: input.status,
          evidence: input.evidence ?? step.evidence,
          skipReason: input.status === 'skipped' ? input.skipReason!.trim() : null,
          startedAt: input.status === 'in_progress' && !step.startedAt ? now : step.startedAt,
          completedAt: input.status === 'completed' || input.status === 'skipped' ? now : null,
          updatedAt: now,
        })
        .where(eq(aiPlanSteps.id, step.id));
      await tx
        .update(aiPlans)
        .set({
          progressVersion: madeProgress ? plan.progressVersion + 1 : plan.progressVersion,
          ...(madeProgress ? { noProgressRuns: 0 } : {}),
          updatedAt: now,
        })
        .where(eq(aiPlans.id, plan.id));
      return madeProgress;
    });
    return { ...(await this.requireSnapshot(input.userId, input.conversationId)), progressMade };
  }

  async pause(
    userId: string,
    conversationId: string,
    reason: string,
    options: { requiresRevision?: boolean } = {}
  ): Promise<AIPlanRuntimeSnapshot> {
    const plan = await this.requireActivePlan(userId, conversationId);
    if (plan.status === 'paused') return this.snapshot(plan);
    if (plan.status !== 'executing' && plan.status !== 'verifying') {
      throw new AppError(409, 'AI_PLAN_NOT_PAUSABLE', 'The active plan cannot be paused');
    }
    await this.stopActiveClock(plan, {
      status: options.requiresRevision ? 'drafting' : 'paused',
      pauseReason: reason.trim() || (options.requiresRevision ? 'Plan revision required' : 'Paused'),
    });
    return this.requireSnapshot(userId, conversationId);
  }

  async requestPause(userId: string, conversationId: string, reason: string): Promise<AIPlanRuntimeSnapshot> {
    const plan = await this.requireActivePlan(userId, conversationId);
    if (plan.status === 'pause_requested' || plan.status === 'paused') return this.snapshot(plan);
    if (plan.status !== 'executing' && plan.status !== 'verifying') {
      throw new AppError(409, 'AI_PLAN_NOT_PAUSABLE', 'The active plan cannot be paused');
    }
    await this.db
      .update(aiPlans)
      .set({ status: 'pause_requested', pauseReason: reason.trim() || 'Pause requested', updatedAt: new Date() })
      .where(eq(aiPlans.id, plan.id));
    return this.requireSnapshot(userId, conversationId);
  }

  async completePauseRequest(userId: string, conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    const plan = await this.requireActivePlan(userId, conversationId);
    if (plan.status === 'paused') return this.snapshot(plan);
    if (plan.status !== 'pause_requested') {
      throw new AppError(409, 'AI_PLAN_PAUSE_NOT_REQUESTED', 'The active plan has no pending pause request');
    }
    await this.stopActiveClock(plan, {
      status: 'paused',
      pauseReason: plan.pauseReason || 'Paused by user',
    });
    return this.requireSnapshot(userId, conversationId);
  }

  async resume(userId: string, conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    const plan = await this.requireActivePlan(userId, conversationId);
    if (plan.status === 'executing') return this.snapshot(plan);
    if (plan.status !== 'paused' && plan.status !== 'pause_requested') {
      throw new AppError(409, 'AI_PLAN_NOT_PAUSED', 'The active plan is not paused');
    }
    const [latestRun] = await this.db
      .select({ purpose: aiRuns.purpose })
      .from(aiRuns)
      .where(eq(aiRuns.planId, plan.id))
      .orderBy(desc(aiRuns.createdAt))
      .limit(1);
    const now = new Date();
    await this.db
      .update(aiPlans)
      .set({
        status: latestRun?.purpose === 'plan_verification' ? 'verifying' : 'executing',
        activeSince: now,
        pauseReason: null,
        updatedAt: now,
      })
      .where(eq(aiPlans.id, plan.id));
    return this.requireSnapshot(userId, conversationId);
  }

  async cancel(userId: string, conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    const plan = await this.requireActivePlan(userId, conversationId);
    await this.stopActiveClock(plan, { status: 'cancelled', cancelledAt: new Date(), pauseReason: null });
    return this.snapshotById(userId, plan.id);
  }

  async requestFinalVerification(userId: string, conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    const plan = await this.requireActivePlan(userId, conversationId);
    if (plan.status !== 'executing') {
      throw new AppError(409, 'AI_PLAN_NOT_EXECUTING', 'The active plan is not executing');
    }
    const revision = await requireAcceptedRevision(this.db, plan.id);
    const steps = await this.db.select().from(aiPlanSteps).where(eq(aiPlanSteps.revisionId, revision.id));
    if (steps.some((step) => step.status !== 'completed' && step.status !== 'skipped')) {
      throw new AppError(
        409,
        'AI_PLAN_INCOMPLETE',
        'Every plan step must be completed or skipped before final verification'
      );
    }
    if (steps.some((step) => step.status === 'skipped' && !step.skipReason)) {
      throw new AppError(409, 'AI_PLAN_SKIP_REASON_REQUIRED', 'Every skipped step must include a reason');
    }
    await this.db
      .update(aiPlans)
      .set({ status: 'verifying', pauseReason: null, updatedAt: new Date() })
      .where(eq(aiPlans.id, plan.id));
    return this.requireSnapshot(userId, conversationId);
  }

  async submitFinalVerification(input: {
    userId: string;
    conversationId: string;
    verdict: 'pass' | 'revise';
    summary: string;
    findings: string[];
  }): Promise<AIPlanRuntimeSnapshot & { completionPending?: boolean }> {
    const plan = await this.requireActivePlan(input.userId, input.conversationId);
    if (plan.status !== 'verifying') {
      throw new AppError(409, 'AI_PLAN_NOT_VERIFYING', 'The active plan is not awaiting final verification');
    }
    if (input.verdict === 'pass') {
      await this.db
        .update(aiPlans)
        .set({ pauseReason: input.summary.trim(), updatedAt: new Date() })
        .where(eq(aiPlans.id, plan.id));
      return {
        ...(await this.requireSnapshot(input.userId, input.conversationId)),
        completionPending: true,
      };
    }

    await this.db.transaction(async (tx) => {
      const revision = await requireAcceptedRevision(tx, plan.id);
      const [ordinalRow] = await tx
        .select({ ordinal: max(aiPlanSteps.ordinal) })
        .from(aiPlanSteps)
        .where(eq(aiPlanSteps.revisionId, revision.id));
      const firstOrdinal = (ordinalRow?.ordinal ?? -1) + 1;
      const findings = cleanStrings(input.findings);
      if (findings.length === 0) findings.push(input.summary.trim() || 'Address final verification findings');
      await tx.insert(aiPlanSteps).values(
        findings.map((finding, index) => ({
          revisionId: revision.id,
          ordinal: firstOrdinal + index,
          title: `Verification follow-up ${index + 1}`,
          description: finding,
          verification: 'Repeat final verification and confirm this finding is resolved.',
        }))
      );
      const now = new Date();
      await tx
        .update(aiPlans)
        .set({
          status: 'executing',
          activeSince: plan.activeSince ?? now,
          pauseReason: input.summary.trim(),
          progressVersion: plan.progressVersion + 1,
          updatedAt: now,
        })
        .where(eq(aiPlans.id, plan.id));
    });
    return this.requireSnapshot(input.userId, input.conversationId);
  }

  async completeFinalVerificationAfterRun(userId: string, conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    const plan = await this.requireActivePlan(userId, conversationId);
    if (plan.status !== 'verifying') {
      throw new AppError(409, 'AI_PLAN_NOT_VERIFYING', 'The active plan is not awaiting final verification');
    }
    await this.stopActiveClock(plan, {
      status: 'completed',
      completedAt: new Date(),
    });
    return this.snapshotById(userId, plan.id);
  }

  async recordExecutionRunOutcome(
    userId: string,
    conversationId: string,
    madeProgress: boolean
  ): Promise<AIPlanRuntimeSnapshot | null> {
    const plan = await this.getActivePlan(userId, conversationId);
    if (!plan || plan.status !== 'executing') return plan ? this.snapshot(plan) : null;
    if (madeProgress) {
      if (plan.noProgressRuns !== 0) {
        await this.db.update(aiPlans).set({ noProgressRuns: 0, updatedAt: new Date() }).where(eq(aiPlans.id, plan.id));
      }
      return this.requireSnapshot(userId, conversationId);
    }

    const noProgressRuns = plan.noProgressRuns + 1;
    if (noProgressRuns >= 3) {
      await this.stopActiveClock(plan, {
        status: 'paused',
        noProgressRuns,
        pauseReason: 'Plan execution made no measurable progress in three consecutive runs.',
      });
    } else {
      await this.db.update(aiPlans).set({ noProgressRuns, updatedAt: new Date() }).where(eq(aiPlans.id, plan.id));
    }
    return this.requireSnapshot(userId, conversationId);
  }

  async getActivePlanSnapshot(userId: string, conversationId: string): Promise<AIPlanRuntimeSnapshot | null> {
    const plan = await this.getActivePlan(userId, conversationId);
    return plan ? this.snapshot(plan) : null;
  }

  async getLatestPlanSnapshot(userId: string, conversationId: string): Promise<AIPlanRuntimeSnapshot | null> {
    const [plan] = await this.db
      .select()
      .from(aiPlans)
      .where(and(eq(aiPlans.userId, userId), eq(aiPlans.conversationId, conversationId)))
      .orderBy(desc(aiPlans.createdAt))
      .limit(1);
    return plan ? this.snapshot(plan) : null;
  }

  async listPlanSnapshots(userId: string, conversationId: string): Promise<AIPlanRuntimeSnapshot[]> {
    const plans = await this.db
      .select()
      .from(aiPlans)
      .where(and(eq(aiPlans.userId, userId), eq(aiPlans.conversationId, conversationId)))
      .orderBy(asc(aiPlans.createdAt));
    const snapshots: AIPlanRuntimeSnapshot[] = [];
    for (const plan of plans) {
      const revisions = await this.db
        .select({ id: aiPlanRevisions.id })
        .from(aiPlanRevisions)
        .where(and(eq(aiPlanRevisions.planId, plan.id), isNotNull(aiPlanRevisions.publishedAt)))
        .orderBy(asc(aiPlanRevisions.revision));
      for (const revision of revisions) {
        snapshots.push(await this.snapshot(plan, 'latest_published', revision.id));
      }
    }
    return snapshots;
  }

  async listRecoverablePlans(): Promise<Array<{ userId: string; conversationId: string }>> {
    return this.db
      .select({ userId: aiPlans.userId, conversationId: aiPlans.conversationId })
      .from(aiPlans)
      .where(inArray(aiPlans.status, ['drafting', 'validating', 'executing', 'pause_requested', 'verifying']));
  }

  async isPlanning(userId: string, conversationId: string): Promise<boolean> {
    const plan = await this.getActivePlan(userId, conversationId);
    return plan?.status === 'drafting' || plan?.status === 'validating' || plan?.status === 'awaiting_decision';
  }

  private async getActivePlan(userId: string, conversationId: string): Promise<AIPlan | null> {
    const rows = await this.db
      .select()
      .from(aiPlans)
      .where(
        and(
          eq(aiPlans.userId, userId),
          eq(aiPlans.conversationId, conversationId),
          inArray(aiPlans.status, ACTIVE_PLAN_STATUSES)
        )
      )
      .orderBy(desc(aiPlans.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  private async requireActivePlan(userId: string, conversationId: string): Promise<AIPlan> {
    const plan = await this.getActivePlan(userId, conversationId);
    if (!plan) throw new AppError(404, 'AI_PLAN_NOT_FOUND', 'No active plan exists for this Work Session');
    return plan;
  }

  private async requireSnapshot(userId: string, conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    const plan = await this.requireActivePlan(userId, conversationId);
    return this.snapshot(plan);
  }

  private async snapshotById(userId: string, planId: string): Promise<AIPlanRuntimeSnapshot> {
    const [plan] = await this.db
      .select()
      .from(aiPlans)
      .where(and(eq(aiPlans.id, planId), eq(aiPlans.userId, userId)))
      .limit(1);
    if (!plan) throw new AppError(404, 'AI_PLAN_NOT_FOUND', 'AI plan not found');
    return this.snapshot(plan);
  }

  private async snapshot(
    plan: AIPlan,
    revisionMode: 'latest' | 'latest_published' = 'latest',
    revisionId?: string
  ): Promise<AIPlanRuntimeSnapshot> {
    const [revision] = await this.db
      .select()
      .from(aiPlanRevisions)
      .where(
        revisionId
          ? and(eq(aiPlanRevisions.planId, plan.id), eq(aiPlanRevisions.id, revisionId))
          : revisionMode === 'latest_published'
            ? and(eq(aiPlanRevisions.planId, plan.id), isNotNull(aiPlanRevisions.publishedAt))
            : eq(aiPlanRevisions.planId, plan.id)
      )
      .orderBy(desc(aiPlanRevisions.revision))
      .limit(1);
    const steps = revision
      ? await this.db
          .select()
          .from(aiPlanSteps)
          .where(eq(aiPlanSteps.revisionId, revision.id))
          .orderBy(asc(aiPlanSteps.ordinal))
      : [];
    const activeTimeMs =
      plan.activeTimeMs + (plan.activeSince ? Math.max(0, Date.now() - plan.activeSince.getTime()) : 0);
    return {
      id: plan.id,
      conversationId: plan.conversationId,
      status: plan.status,
      title: plan.title,
      model: plan.model,
      reasoningEffort: plan.reasoningEffort,
      revisionId: revision?.id ?? null,
      revision: revision?.revision ?? null,
      revisionStatus: revision?.status ?? null,
      publishedAt: revision?.publishedAt?.toISOString() ?? null,
      timelineAnchorAt: revision?.publishedAt?.toISOString() ?? null,
      acceptedAt: revision?.acceptedAt?.toISOString() ?? null,
      goal: revision?.goal ?? null,
      scope: revision?.scope ?? [],
      assumptions: revision?.assumptions ?? [],
      research: revision?.research ?? [],
      intentReview: revision?.intentReview ?? null,
      securityReview: revision?.securityReview ?? null,
      verification: revision?.verification ?? [],
      changeSummary: revision?.changeSummary ?? null,
      steps: steps.map((step) => ({
        id: step.id,
        ordinal: step.ordinal,
        title: step.title,
        description: step.description,
        verification: step.verification,
        status: step.status,
        evidence: step.evidence,
        skipReason: step.skipReason,
        startedAt: step.startedAt?.toISOString() ?? null,
        completedAt: step.completedAt?.toISOString() ?? null,
      })),
      noProgressRuns: plan.noProgressRuns,
      activeTimeMs,
      activeSince: plan.activeSince?.toISOString() ?? null,
      pauseReason: plan.pauseReason,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  }

  private async stopActiveClock(plan: AIPlan, update: Partial<typeof aiPlans.$inferInsert>): Promise<void> {
    const now = new Date();
    const elapsed = plan.activeSince ? Math.max(0, now.getTime() - plan.activeSince.getTime()) : 0;
    await this.db
      .update(aiPlans)
      .set({ ...update, activeTimeMs: plan.activeTimeMs + elapsed, activeSince: null, updatedAt: now })
      .where(eq(aiPlans.id, plan.id));
  }
}

async function requireAcceptedRevision(db: DrizzleExecutor, planId: string) {
  const [revision] = await db
    .select()
    .from(aiPlanRevisions)
    .where(and(eq(aiPlanRevisions.planId, planId), eq(aiPlanRevisions.status, 'accepted')))
    .orderBy(desc(aiPlanRevisions.revision))
    .limit(1);
  if (!revision) throw new AppError(409, 'AI_PLAN_REVISION_NOT_ACCEPTED', 'No accepted plan revision exists');
  return revision;
}

function cleanStrings(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function cleanOptional(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned || null;
}
