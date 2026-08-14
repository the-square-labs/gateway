import { describe, expect, it } from 'vitest';
import { shouldEndRunAfterPlanTool } from './ai.service.js';

describe('Plan verification run lifecycle', () => {
  it('ends the planning run after a reviewed plan is published', () => {
    expect(
      shouldEndRunAfterPlanTool('submit_plan_review', { published: true, requiresQuestion: false }, undefined)
    ).toBe(true);
  });

  it('keeps the planning run alive only when validation needs another user answer', () => {
    expect(
      shouldEndRunAfterPlanTool('submit_plan_review', { published: false, requiresQuestion: true }, undefined)
    ).toBe(false);
  });

  it('ends the direct run after natural-language plan execution starts', () => {
    expect(shouldEndRunAfterPlanTool('start_plan_execution', { status: 'executing' }, undefined)).toBe(true);
  });

  it('keeps the run alive for the final response while completion is pending', () => {
    expect(
      shouldEndRunAfterPlanTool('submit_plan_verification', { status: 'verifying', completionPending: true }, undefined)
    ).toBe(false);
  });

  it('ends the current verifier run when findings return the plan to execution', () => {
    expect(shouldEndRunAfterPlanTool('submit_plan_verification', { status: 'executing' }, undefined)).toBe(true);
  });
});
