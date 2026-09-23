const AUTH_ENTRY_PATHS = new Set(["/login", "/reset-password", "/callback"]);

/**
 * Always send signed-out browsers to the login page. `/auth/login` only
 * handles OIDC, so on local-auth installs it cannot sign anyone in; the login
 * page offers every enabled method (including SSO) and forwards `return_to`.
 */
export function getLoginRedirectUrl(returnTo = window.location.href): string {
  const absoluteReturnTo = new URL(returnTo, window.location.origin).href;
  return `/login?return_to=${encodeURIComponent(absoluteReturnTo)}`;
}

/** Resolve `return_to` to a same-origin path; anything else falls back to "/". */
export function resolveAuthReturnTo(search: string, origin = window.location.origin): string {
  const value = new URLSearchParams(search).get("return_to");
  if (!value) return "/";

  try {
    const target = new URL(value, origin);
    if (target.origin !== origin || AUTH_ENTRY_PATHS.has(target.pathname)) return "/";
    // A path such as "//evil.example" is protocol-relative once handed to
    // location.assign; only a single leading slash keeps it on this origin.
    if (!target.pathname.startsWith("/") || /^\/[/\\]/.test(target.pathname)) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}
