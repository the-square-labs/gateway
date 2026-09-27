/** The statuses a redirect route may answer with (the route schema accepts exactly these). */
export const REDIRECT_STATUS_OPTIONS = [
  { value: 301, label: "301 — Permanent" },
  { value: 302, label: "302 — Temporary" },
  { value: 307, label: "307 — Temporary, preserve method" },
  { value: 308, label: "308 — Permanent, preserve method" },
] as const;
