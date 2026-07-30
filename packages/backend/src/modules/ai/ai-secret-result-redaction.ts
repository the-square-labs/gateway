const ONE_TIME_SECRET_REDACTION = '[REDACTED_ONE_TIME_SECRET]';
const GITLAB_SECRET_TOOL_PREFIX = /^gitlab_/;
const GITLAB_SECRET_KEY_RE = /^(?:token|secret|password|value|privateKey|private_key|webhookSecret|webhook_secret)$/i;
const GITLAB_SAFE_SECRET_METADATA_RE = /(?:masked|last4|hash|redacted)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function redactOneTimeSecretToolResult(toolName: string, value: unknown): unknown {
  if (
    (toolName === 'manage_api_token' || toolName === 'manage_inference_token') &&
    isRecord(value) &&
    typeof value.token === 'string'
  ) {
    return {
      ...value,
      token: ONE_TIME_SECRET_REDACTION,
      tokenRedacted: true,
    };
  }

  if (!GITLAB_SECRET_TOOL_PREFIX.test(toolName) || !isRecord(value)) {
    return value;
  }

  return redactGitLabSecretResult(value);
}

function redactGitLabSecretResult(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[REDACTED_DEPTH_LIMIT]';
  if (Array.isArray(value)) return value.map((item) => redactGitLabSecretResult(item, depth + 1));
  if (!isRecord(value)) return value;

  let redactedAny = false;
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (
      GITLAB_SECRET_KEY_RE.test(key) &&
      !GITLAB_SAFE_SECRET_METADATA_RE.test(key) &&
      typeof nested === 'string' &&
      nested.length > 0
    ) {
      redacted[key] = ONE_TIME_SECRET_REDACTION;
      redacted[`${key}Redacted`] = true;
      redactedAny = true;
      continue;
    }
    redacted[key] = redactGitLabSecretResult(nested, depth + 1);
  }
  if (redactedAny) redacted.secretResultRedacted = true;
  return redacted;
}
