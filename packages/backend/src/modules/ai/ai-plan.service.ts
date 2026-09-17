import type { DrizzleClient } from '@/db/client.js';
import type {
  AIPlanChangeSummary,
  AIPlanResearchFinding,
  AIPlanReview,
  AIPlanStepEvidence,
  AIPlanStepStatus,
  AIPlanVerificationCriterion,
  AIRunPurpose,
} from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AIPlanRuntimeSnapshot } from './ai.types.js';
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
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the commercial factory constructor contract.
  constructor(_db: DrizzleClient) {}
  async enterPlan(_input: {
    userId: string;
    conversationId: string;
    title?: string;
    model?: string | null;
    reasoningEffort?: string | null;
  }): Promise<AIPlanRuntimeSnapshot> {
    return commercialModuleUnavailable();
  }
  async submitPlan(_userId: string, _conversationId: string, _input: AIPlanDraftInput): Promise<AIPlanRuntimeSnapshot> {
    return commercialModuleUnavailable();
  }
  async submitPlanReview(_input: {
    userId: string;
    conversationId: string;
    intentReview: AIPlanReview;
    securityReview: AIPlanReview;
  }): Promise<{ plan: AIPlanRuntimeSnapshot; published: boolean; requiresQuestion: boolean }> {
    return commercialModuleUnavailable();
  }
  async recoverFailedValidation(
    _userId: string,
    _conversationId: string,
    _planId: string,
    _reason: string
  ): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async recoverStoppedPlanRun(
    _userId: string,
    _conversationId: string,
    _planId: string,
    _purpose: AIRunPurpose,
    _reason: string
  ): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async decide(_input: {
    userId: string;
    conversationId: string;
    planId: string;
    revisionId: string;
    decision: 'implement' | 'refine' | 'custom';
    customInstruction?: string;
    clientCommandId: string;
  }): Promise<{ plan: AIPlanRuntimeSnapshot; duplicate: boolean }> {
    return commercialModuleUnavailable();
  }
  async startExecution(_userId: string, _conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    return commercialModuleUnavailable();
  }
  async updateStep(_input: {
    userId: string;
    conversationId: string;
    status: AIPlanStepStatus;
    evidence?: AIPlanStepEvidence[];
    skipReason?: string;
  }): Promise<AIPlanRuntimeSnapshot & { progressMade: boolean }> {
    return commercialModuleUnavailable();
  }
  async pause(
    _userId: string,
    _conversationId: string,
    _reason: string,
    _options: { requiresRevision?: boolean } = {}
  ): Promise<AIPlanRuntimeSnapshot> {
    return commercialModuleUnavailable();
  }
  async requestPause(_userId: string, _conversationId: string, _reason: string): Promise<AIPlanRuntimeSnapshot> {
    return commercialModuleUnavailable();
  }
  async completePauseRequest(_userId: string, _conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    return commercialModuleUnavailable();
  }
  async resume(_userId: string, _conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    return commercialModuleUnavailable();
  }
  async cancel(_userId: string, _conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    return commercialModuleUnavailable();
  }
  async requestFinalVerification(_userId: string, _conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    return commercialModuleUnavailable();
  }
  async submitFinalVerification(_input: {
    userId: string;
    conversationId: string;
    verdict: 'pass' | 'revise';
    summary: string;
    findings: string[];
  }): Promise<AIPlanRuntimeSnapshot & { completionPending?: boolean }> {
    return commercialModuleUnavailable();
  }
  async completeFinalVerificationAfterRun(_userId: string, _conversationId: string): Promise<AIPlanRuntimeSnapshot> {
    return commercialModuleUnavailable();
  }
  async recordExecutionRunOutcome(
    _userId: string,
    _conversationId: string,
    _madeProgress: boolean
  ): Promise<AIPlanRuntimeSnapshot | null> {
    return commercialModuleUnavailable();
  }
  async getActivePlanSnapshot(_userId: string, _conversationId: string): Promise<AIPlanRuntimeSnapshot | null> {
    return null;
  }
  async getLatestPlanSnapshot(_userId: string, _conversationId: string): Promise<AIPlanRuntimeSnapshot | null> {
    return null;
  }
  async listPlanSnapshots(_userId: string, _conversationId: string): Promise<AIPlanRuntimeSnapshot[]> {
    return [];
  }
  async listRecoverablePlans(): Promise<Array<{ userId: string; conversationId: string }>> {
    return [];
  }
  async isPlanning(_userId: string, _conversationId: string): Promise<boolean> {
    return false;
  }
}
