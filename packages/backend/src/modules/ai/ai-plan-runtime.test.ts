import { describe, expect, it } from 'vitest';
import { shouldEndRunAfterPlanTool } from './ai.service.js';

describe('Plan verification run lifecycle', () => {
  it('keeps the run alive for the final response while completion is pending', () => {
    expect(
      shouldEndRunAfterPlanTool('submit_plan_verification', { status: 'verifying', completionPending: true }, undefined)
    ).toBe(false);
  });

  it('ends the current verifier run when findings return the plan to execution', () => {
    expect(shouldEndRunAfterPlanTool('submit_plan_verification', { status: 'executing' }, undefined)).toBe(true);
  });
});
