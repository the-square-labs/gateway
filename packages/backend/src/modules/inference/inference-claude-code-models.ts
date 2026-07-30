const CLAUDE_CODE_MODEL_PREFIX = 'claude-gateway-';

export function claudeCodeModelAlias(modelId: string): string {
  return `${CLAUDE_CODE_MODEL_PREFIX}${Buffer.from(modelId, 'utf8').toString('base64url')}`;
}

export function resolveClaudeCodeModelAlias(modelId: string): string {
  if (!modelId.startsWith(CLAUDE_CODE_MODEL_PREFIX)) return modelId;
  const encoded = modelId.slice(CLAUDE_CODE_MODEL_PREFIX.length);
  if (!encoded) return modelId;
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    return claudeCodeModelAlias(decoded) === modelId ? decoded : modelId;
  } catch {
    return modelId;
  }
}
