export const FINALIZE_SETUP_STEPS = [
  "nodes",
  "ai_assistant",
  "inference",
  "cloudflare",
  "gitlab",
  "mfa",
  "invite_users",
] as const;

export type FinalizeSetupStep = (typeof FINALIZE_SETUP_STEPS)[number];
export type FinalizeSetupStepStatus = "pending" | "configured" | "skipped";

export interface FinalizeSetupState {
  steps: Record<FinalizeSetupStep, FinalizeSetupStepStatus>;
}
