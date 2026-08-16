const AUTH_ENTRY_PATHS = new Set(["/login", "/reset-password", "/callback"]);

export function getLoginRedirectUrl(returnTo = window.location.href): string {
  const absoluteReturnTo = new URL(returnTo, window.location.origin).href;
  const returnPath = new URL(absoluteReturnTo).pathname;
  const loginPath = returnPath.startsWith("/oauth/") ? "/auth/login" : "/login";
  return `${loginPath}?return_to=${encodeURIComponent(absoluteReturnTo)}`;
}

export function resolveAuthReturnTo(search: string, origin = window.location.origin): string {
  const value = new URLSearchParams(search).get("return_to");
  if (!value) return "/";

  try {
    const target = new URL(value, origin);
    if (target.origin !== origin || AUTH_ENTRY_PATHS.has(target.pathname)) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}
