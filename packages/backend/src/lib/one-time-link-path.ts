/**
 * Request paths of every one-time link route (`/api/pages-upload`,
 * `/api/docker-archive-link`); see one-time-link.ts. Group 1 is the path before
 * the token: logs keep it and redact the token, and the JSON body limit skips
 * these routes because their handlers enforce their own size limits. Kept
 * free of imports so the logger can use it.
 */
export const ONE_TIME_LINK_TOKEN_PATH = /^(\/api\/(?:pages-upload|docker-archive-link)\/)[^/]+(?=\/|$)/;
