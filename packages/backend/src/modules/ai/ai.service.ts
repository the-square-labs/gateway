export {
  type AIContextCompactionResult,
  type AIContextCompactionTrigger,
  shouldEndRunAfterPlanTool,
} from './ai.service.runtime-helpers.js';

import { AIServiceContinuation } from './ai.service.continuation.js';

export class AIService extends AIServiceContinuation {}
