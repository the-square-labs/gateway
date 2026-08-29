import { CONTROL_AI_TOOLS } from './ai.tools.control.js';
import { DATABASE_AI_TOOLS } from './ai.tools.databases.js';
import { DISCOVERY_AI_TOOLS } from './ai.tools.discovery.js';
import { DOCKER_AI_TOOLS } from './ai.tools.docker.js';
import { FOLDER_AI_TOOLS } from './ai.tools.folders.js';
import { GITLAB_AI_TOOLS } from './ai.tools.gitlab.js';
import { INFERENCE_AI_TOOLS } from './ai.tools.inference.js';
import { INGRESS_AI_TOOLS } from './ai.tools.ingress.js';
import { INTEGRATION_AI_TOOLS } from './ai.tools.integrations.js';
import { NOTIFICATION_AI_TOOLS, WEB_SEARCH_AI_TOOL } from './ai.tools.notifications.js';
import { OPERATION_AI_TOOLS } from './ai.tools.operations.js';
import { PKI_AI_TOOLS } from './ai.tools.pki.js';
import { PLAN_AI_TOOLS } from './ai.tools.planning.js';
import { PLATFORM_AI_TOOLS } from './ai.tools.platform.js';
import { RESOURCE_SETUP_AI_TOOLS } from './ai.tools.resource-setup.js';
import { SANDBOX_AI_TOOLS } from './ai.tools.sandbox.js';
import { SSH_AI_TOOLS } from './ai.tools.ssh.js';
import type { AIToolDefinition } from './ai.types.js';
import { createAIToolArgumentValidator } from './ai-tool-contract.js';
import { canUseAiTool } from './ai-tool-filtering.js';
import { withAIToolPolicyMetadata } from './ai-tool-policy-metadata.js';

const AI_TOOL_DEFINITIONS: AIToolDefinition[] = [
  ...DISCOVERY_AI_TOOLS,
  ...PKI_AI_TOOLS,
  ...FOLDER_AI_TOOLS,
  ...INGRESS_AI_TOOLS,
  ...PLATFORM_AI_TOOLS,
  ...CONTROL_AI_TOOLS,
  ...DOCKER_AI_TOOLS,
  ...DATABASE_AI_TOOLS,
  ...GITLAB_AI_TOOLS,
  ...INTEGRATION_AI_TOOLS,
  ...INFERENCE_AI_TOOLS,
  ...OPERATION_AI_TOOLS,
  ...RESOURCE_SETUP_AI_TOOLS,
  ...SANDBOX_AI_TOOLS,
  ...SSH_AI_TOOLS,
  ...NOTIFICATION_AI_TOOLS,
  WEB_SEARCH_AI_TOOL,
  ...PLAN_AI_TOOLS,
];

export const AI_TOOLS: AIToolDefinition[] = withAIToolPolicyMetadata(AI_TOOL_DEFINITIONS);

const destructiveSet = new Set(AI_TOOLS.filter((t) => t.destructive).map((t) => t.name));
const REQUIRED_RUNTIME_AI_TOOL_NAMES = new Set([
  'read_tool_output',
  'search_tool_output',
  'read_skill',
  'activate_skill',
]);
const BASE_AI_TOOL_NAMES = new Set([
  'enter_plan_mode',
  'submit_plan',
  'submit_plan_review',
  'start_plan_execution',
  'update_plan_step',
  'pause_plan_execution',
  'resume_plan_execution',
  'finalize_plan_execution',
  'submit_plan_verification',
  'discover_tools',
  'read_skill',
  'activate_skill',
  'get_current_context',
  'read_tool_output',
  'search_tool_output',
  'wait',
  'send_comment',
  'end_conversation',
  'find_resource',
  'ask_question',
  'internal_documentation',
  'search_chats',
  'search_compacted_history',
  'find_in_chat',
  'read_chat_slice',
  'list_chat_projects',
  'fetch',
  'web_search',
]);

export function isBaseAIToolName(name: string): boolean {
  return BASE_AI_TOOL_NAMES.has(name);
}

const TOOL_NAME_BOUNDARY = '[^a-zA-Z0-9_]';

export function isDestructiveTool(name: string): boolean {
  return destructiveSet.has(name);
}

export function inferDiscoveredToolsetsFromText(text: string): string[] {
  const discovered = new Set<string>();
  for (const tool of AI_TOOLS) {
    if (BASE_AI_TOOL_NAMES.has(tool.name)) continue;
    if (matchesToolName(text, tool.name)) discovered.add(tool.category);
  }
  return [...discovered].sort((a, b) => a.localeCompare(b));
}

function matchesToolName(text: string, toolName: string): boolean {
  const escapedName = escapeRegExp(toolName);
  if (new RegExp(`(^|${TOOL_NAME_BOUNDARY})${escapedName}($|${TOOL_NAME_BOUNDARY})`, 'i').test(text)) return true;

  const readableName = escapeRegExp(toolName.replaceAll('_', ' '));
  return new RegExp(`(^|${TOOL_NAME_BOUNDARY})${readableName}($|${TOOL_NAME_BOUNDARY})`, 'i').test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Map of tool names to frontend store names that should be invalidated after execution.
 */
export const TOOL_STORE_INVALIDATION_MAP: Record<string, string[]> = Object.fromEntries(
  AI_TOOLS.filter((t) => t.invalidateStores.length > 0).map((t) => [t.name, t.invalidateStores])
);

const AI_TOOL_ARGUMENT_VALIDATOR = createAIToolArgumentValidator(AI_TOOLS);

export function parseAndValidateAIToolArguments(toolName: string, rawArguments: string) {
  return AI_TOOL_ARGUMENT_VALIDATOR.parseAndValidate(toolName, rawArguments);
}

export function validateAIToolArguments(toolName: string, argumentsValue: unknown) {
  return AI_TOOL_ARGUMENT_VALIDATOR.validate(toolName, argumentsValue);
}

/**
 * Get tools in OpenAI function-calling format, filtered by:
 * - Disabled tools (admin config)
 * - User scopes (only tools the user has the required scope for)
 * - Web search availability
 */
export function getOpenAITools(
  disabledTools: string[],
  userScopes: string[],
  webSearchEnabled: boolean,
  options: { discoveredToolsets?: string[]; sandboxEnabled?: boolean; planningMode?: boolean } = {}
): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  const discoveredToolsets = options.discoveredToolsets === undefined ? undefined : new Set(options.discoveredToolsets);
  return AI_TOOLS.filter((t) => {
    if (t.mcpOnly) return false;
    if (options.planningMode && t.planningAccess !== 'allowed') return false;
    if (disabledTools.includes(t.name) && !REQUIRED_RUNTIME_AI_TOOL_NAMES.has(t.name)) return false;
    if (t.name === 'web_search' && !webSearchEnabled) return false;
    if (t.category === 'Sandbox' && options.sandboxEnabled !== true) return false;
    if (discoveredToolsets && !BASE_AI_TOOL_NAMES.has(t.name) && !discoveredToolsets.has(t.category)) return false;
    // Every tool must have a requiredScope — reject tools without one
    if (!t.requiredScope) return false;
    return canUseAiTool(t.name, t.requiredScope, userScopes, t.requiredScopes);
  }).map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
