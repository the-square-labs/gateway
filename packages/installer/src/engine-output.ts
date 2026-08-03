const ENGINE_STEP_PREFIX = '@@wiolett-step:';

export function engineStep(line: string): string | undefined {
  if (line.startsWith(ENGINE_STEP_PREFIX)) return line.slice(ENGINE_STEP_PREFIX.length);
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const status = stringValue(event.status) ?? stringValue(event.text) ?? stringValue(event.message);
    if (!status) return undefined;
    const subject = stringValue(event.id) ?? stringValue(event.name);
    const progress = progressText(event);
    return [subject, status, progress].filter(Boolean).join(' · ');
  } catch {
    return undefined;
  }
}

export function failureSummary(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(ENGINE_STEP_PREFIX) && !line.startsWith('{'));
  return lines.slice(-4).map(redact).join('\n');
}

function progressText(event: Record<string, unknown>): string | undefined {
  const detail = objectValue(event.progressDetail) ?? objectValue(event.progress);
  if (!detail) return stringValue(event.progress);
  const current = numberValue(detail.current);
  const total = numberValue(detail.total);
  if (current !== undefined && total && total > 0) return `${Math.min(100, Math.round((current / total) * 100))}%`;
  return stringValue(event.progress);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function redact(line: string): string {
  return line
    .replace(/(--(?:token|smtp-password|oidc-client-secret|initial-admin-password)(?:=|\s+))\S+/gi, '$1<redacted>')
    .replace(/\bgw_node_[A-Za-z0-9_-]+\b/g, '<redacted-token>');
}
