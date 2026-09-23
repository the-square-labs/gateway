/** Database name accepted inside a new managed database (matches the backend restore schema). */
export const MANAGED_DATABASE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/**
 * Mirrors the backend's default restore target name: replace anything outside
 * letters, digits and underscore, prefix an underscore when the name does not
 * start with a letter or underscore, cap at 63 characters, and fall back to
 * `app` when nothing usable remains. For example, `my-app` becomes `my_app`.
 */
export function normalizeManagedDatabaseName(value: string | null | undefined): string {
  if (!value) return "app";
  let name = value.trim().replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z_]/.test(name)) name = `_${name}`;
  name = name.slice(0, 63);
  return MANAGED_DATABASE_NAME_PATTERN.test(name) && /[A-Za-z0-9]/.test(name) ? name : "app";
}
