/**
 * Why a picker's options could not be loaded, shown in the picker instead of an empty list: a
 * refused request names the missing permission (the API message names the scope), any other
 * failure says so.
 */
export function pickerLoadError(error: unknown, subject: string): string {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const status = typeof record.status === "number" ? record.status : undefined;
  const message = error instanceof Error ? error.message.trim() : "";
  if (status === 403) {
    const details =
      record.details && typeof record.details === "object"
        ? (record.details as { requiredScopes?: unknown })
        : {};
    const scopes = Array.isArray(details.requiredScopes)
      ? details.requiredScopes.filter((scope): scope is string => typeof scope === "string")
      : [];
    const reason = scopes.length > 0 ? `needs ${scopes.join(" or ")}` : message;
    return `You cannot list ${subject}${reason ? `: ${reason}` : ""}.`;
  }
  return `Could not load ${subject}${message ? `: ${message}` : ""}.`;
}

/** Whether a failed load was refused for missing permissions (as opposed to failing). */
export function isPermissionError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { status?: unknown }).status === 403;
}
