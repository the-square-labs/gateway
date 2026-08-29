import type { AIToolDefinition } from './ai.types.js';

export const PLAN_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'enter_plan_mode',
    description:
      'Enter one-shot Plan Mode for a complex, multi-step, research-heavy, or risky task. Do not use it for a simple direct answer. The next run drafts and validates a structured plan before any mutating action is available.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short working title for the plan.' },
        reason: { type: 'string', description: 'Why planning is required for this task.' },
      },
      required: ['title', 'reason'],
    },
    destructive: false,
    category: 'Planning',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'submit_plan',
    description:
      'Submit a complete structured plan after clarification and detailed research, or replace the currently published plan when the user clearly requests a revision. Merely discussing or asking questions about a published plan does not require this tool. Every submitted plan must include implementation steps and verification criteria. Submission starts the separate intent/security validation pass.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        goal: { type: 'string' },
        scope: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
        research: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              summary: { type: 'string' },
              resourceReferenceIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'summary'],
          },
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              verification: { type: 'string' },
            },
            required: ['title', 'description', 'verification'],
          },
        },
        verification: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, description: { type: 'string' } },
            required: ['title', 'description'],
          },
        },
        changeSummary: {
          type: 'object',
          properties: {
            added: { type: 'array', items: { type: 'string' } },
            changed: { type: 'array', items: { type: 'string' } },
            removed: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['title', 'goal', 'scope', 'assumptions', 'research', 'steps', 'verification'],
    },
    destructive: false,
    category: 'Planning',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'submit_plan_review',
    description:
      'Validator-only tool. Submit the independent intent and security review for the current draft plan. If the result requires a question, call ask_question immediately.',
    parameters: {
      type: 'object',
      properties: {
        intentReview: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['pass', 'revise'] },
            summary: { type: 'string' },
            findings: { type: 'array', items: { type: 'string' } },
          },
          required: ['verdict', 'summary', 'findings'],
        },
        securityReview: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['pass', 'revise'] },
            summary: { type: 'string' },
            findings: { type: 'array', items: { type: 'string' } },
          },
          required: ['verdict', 'summary', 'findings'],
        },
      },
      required: ['intentReview', 'securityReview'],
    },
    destructive: false,
    category: 'Planning',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'start_plan_execution',
    description:
      'Start the latest published plan only when the user explicitly asks to execute or proceed with it. Derive the active plan and published revision from the conversation; never ask the user for internal IDs.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Planning',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'update_plan_step',
    description:
      'Update the single active implementation step with structured status and verification evidence. Never report completion only in prose.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'skipped'] },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              resourceReferenceIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['summary'],
          },
        },
        skipReason: { type: 'string' },
      },
      required: ['status'],
    },
    destructive: false,
    category: 'Planning',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  ...['pause_plan_execution', 'resume_plan_execution'].map(
    (name): AIToolDefinition => ({
      name,
      description:
        name === 'pause_plan_execution'
          ? 'Pause the active plan at the next safe boundary and record a concise reason.'
          : 'Resume a paused plan after the blocker is resolved or the user supplies new context.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          requiresRevision: {
            type: 'boolean',
            description: 'Set true only when new user intent materially changes the accepted plan.',
          },
        },
        ...(name === 'pause_plan_execution' ? { required: ['reason'] } : {}),
      },
      destructive: false,
      category: 'Planning',
      requiredScope: 'ai:workspace:use',
      invalidateStores: [],
      historyRetention: { mode: 'persistent_context' },
    })
  ),
  {
    name: 'finalize_plan_execution',
    description:
      'Request final verification only after every required step is completed or explicitly skipped with a reason and the implementation has been verified. This does not directly mark the plan complete.',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
    destructive: false,
    category: 'Planning',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'submit_plan_verification',
    description:
      'Verifier-only tool. Submit the independent final verification result for the active plan. A passing result stays completion-pending until the current AI turn finishes; after it returns, provide the final response and end the turn.',
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['pass', 'revise'] },
        summary: { type: 'string' },
        findings: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'summary', 'findings'],
    },
    destructive: false,
    category: 'Planning',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
];
