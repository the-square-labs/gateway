import type { InferenceMessage } from './inference-protocol.types.js';

export const GATEWAY_COMPACTION_PREFIX = 'ocx1:';

export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';

const OPAQUE_COMPACTION_NOTE =
  '[earlier conversation was compacted; the summary is stored in a format this model cannot read]';
const RETAINED_CHAR_BUDGET = 20_000 * 4;

export function encodeCompactionSummary(summary: string): string {
  return GATEWAY_COMPACTION_PREFIX + Buffer.from(summary, 'utf8').toString('base64');
}

export function decodeCompactionSummary(encryptedContent: string): string | null {
  if (!encryptedContent.startsWith(GATEWAY_COMPACTION_PREFIX)) return null;
  try {
    return Buffer.from(encryptedContent.slice(GATEWAY_COMPACTION_PREFIX.length), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function compactionItemToText(encryptedContent: string): string {
  const decoded = decodeCompactionSummary(encryptedContent);
  return decoded ? `${SUMMARY_PREFIX}\n\n${decoded}` : OPAQUE_COMPACTION_NOTE;
}

export function buildCompactV1Output(messages: InferenceMessage[], summary: string): Record<string, unknown>[] {
  const candidates = messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
    )
    .filter(Boolean);
  const retained: string[] = [];
  let remaining = RETAINED_CHAR_BUDGET;
  for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const text = candidates[index];
    if (text.length <= remaining) {
      retained.push(text);
      remaining -= text.length;
    } else {
      retained.push(text.slice(text.length - remaining));
      break;
    }
  }
  retained.reverse();
  retained.push(`${SUMMARY_PREFIX}\n${summary.trim() || '(no summary available)'}`);
  return retained.map((text) => ({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  }));
}
