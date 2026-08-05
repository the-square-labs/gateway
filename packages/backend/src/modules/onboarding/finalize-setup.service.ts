import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/settings.js';

export const FINALIZE_SETUP_STATE_KEY = 'onboarding:finalize_setup';

export const FINALIZE_SETUP_STEPS = [
  'nodes',
  'ai_assistant',
  'inference',
  'cloudflare',
  'gitlab',
  'mfa',
  'invite_users',
] as const;

export type FinalizeSetupStep = (typeof FINALIZE_SETUP_STEPS)[number];
export type FinalizeSetupStepStatus = 'pending' | 'configured' | 'skipped';

export interface FinalizeSetupState {
  version: 1;
  ownerUserId: string;
  dismissedAt: string | null;
  /** A user can dismiss the post-onboarding MFA reminder without changing the checklist outcome. */
  mfaReminderHiddenAt?: string | null;
  steps: Record<FinalizeSetupStep, FinalizeSetupStepStatus>;
}

export interface FinalizeSetupPublicState {
  steps: Record<FinalizeSetupStep, FinalizeSetupStepStatus>;
}

export class FinalizeSetupUnavailableError extends Error {
  constructor() {
    super('Finalize setup is not available for this account');
  }
}

export class FinalizeSetupStepConflictError extends Error {
  constructor() {
    super('A configured setup item cannot be skipped');
  }
}

function pendingSteps(): Record<FinalizeSetupStep, FinalizeSetupStepStatus> {
  return Object.fromEntries(FINALIZE_SETUP_STEPS.map((step) => [step, 'pending'])) as Record<
    FinalizeSetupStep,
    FinalizeSetupStepStatus
  >;
}

function normalizeState(value: unknown): FinalizeSetupState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<FinalizeSetupState>;
  if (state.version !== 1 || typeof state.ownerUserId !== 'string' || !state.ownerUserId) return null;
  if (state.dismissedAt !== null && typeof state.dismissedAt !== 'string') return null;
  const steps = pendingSteps();
  for (const step of FINALIZE_SETUP_STEPS) {
    const status = state.steps?.[step];
    if (status === 'configured' || status === 'skipped' || status === 'pending') steps[step] = status;
  }
  return {
    version: 1,
    ownerUserId: state.ownerUserId,
    dismissedAt: state.dismissedAt ?? null,
    mfaReminderHiddenAt: typeof state.mfaReminderHiddenAt === 'string' ? state.mfaReminderHiddenAt : null,
    steps,
  };
}

export class FinalizeSetupService {
  constructor(private readonly db: DrizzleClient) {}

  async initializeOwner(userId: string): Promise<void> {
    const state: FinalizeSetupState = {
      version: 1,
      ownerUserId: userId,
      dismissedAt: null,
      mfaReminderHiddenAt: null,
      steps: pendingSteps(),
    };
    await this.db
      .insert(settings)
      .values({ key: FINALIZE_SETUP_STATE_KEY, value: state, updatedAt: new Date() })
      .onConflictDoNothing();
  }

  async clearOwner(userId: string): Promise<void> {
    const state = await this.getStoredState();
    if (!state || state.ownerUserId !== userId) return;
    await this.db.delete(settings).where(eq(settings.key, FINALIZE_SETUP_STATE_KEY));
  }

  async getForUser(userId: string): Promise<FinalizeSetupPublicState | null> {
    const state = await this.getStoredState();
    if (!state || state.ownerUserId !== userId || state.dismissedAt) return null;
    return { steps: state.steps };
  }

  async markStep(
    userId: string,
    step: FinalizeSetupStep,
    status: Exclude<FinalizeSetupStepStatus, 'pending'>
  ): Promise<FinalizeSetupPublicState> {
    const state = await this.requireOwnerState(userId);
    if (state.steps[step] === 'configured' && status === 'skipped') {
      throw new FinalizeSetupStepConflictError();
    }
    if (state.steps[step] === status) return { steps: state.steps };
    const next: FinalizeSetupState = {
      ...state,
      steps: { ...state.steps, [step]: status },
    };
    await this.save(next);
    return { steps: next.steps };
  }

  async dismiss(userId: string): Promise<void> {
    const state = await this.requireOwnerState(userId);
    await this.save({ ...state, dismissedAt: new Date().toISOString() });
  }

  /**
   * The soft MFA reminder is intentionally separate from the checklist itself:
   * dismissing the checklist should not silently turn a skipped MFA step into a
   * completed one.
   */
  async shouldShowMfaReminder(userId: string): Promise<boolean> {
    const state = await this.getStoredState();
    return Boolean(
      state &&
        state.ownerUserId === userId &&
        state.dismissedAt &&
        state.steps.mfa === 'skipped' &&
        !state.mfaReminderHiddenAt
    );
  }

  async hideMfaReminder(userId: string): Promise<void> {
    const state = await this.getStoredState();
    if (!state || state.ownerUserId !== userId) throw new FinalizeSetupUnavailableError();
    if (!state.dismissedAt || state.steps.mfa !== 'skipped' || state.mfaReminderHiddenAt) return;
    await this.save({ ...state, mfaReminderHiddenAt: new Date().toISOString() });
  }

  private async requireOwnerState(userId: string): Promise<FinalizeSetupState> {
    const state = await this.getStoredState();
    if (!state || state.ownerUserId !== userId || state.dismissedAt) throw new FinalizeSetupUnavailableError();
    return state;
  }

  private async getStoredState(): Promise<FinalizeSetupState | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, FINALIZE_SETUP_STATE_KEY)).limit(1);
    return normalizeState(row?.value);
  }

  private async save(state: FinalizeSetupState): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: FINALIZE_SETUP_STATE_KEY, value: state, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: state, updatedAt: new Date() },
      });
  }
}
