import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_REPLAYED_HEADER,
  isIdempotencyEligibleRequest,
} from '@/middleware/idempotency.js';

export const IDEMPOTENCY_KEY_PARAMETER_NAME = 'IdempotencyKey';
const IDEMPOTENCY_KEY_PARAMETER_REF = `#/components/parameters/${IDEMPOTENCY_KEY_PARAMETER_NAME}`;
const DOCUMENTED_METHODS = ['post', 'put', 'patch'] as const;

export const IDEMPOTENCY_API_DESCRIPTION = `## Idempotent retries

Selected create operations accept an optional \`${IDEMPOTENCY_KEY_HEADER}\` header (1-${IDEMPOTENCY_KEY_MAX_LENGTH} printable ASCII characters, for example a UUID); each lists it as a parameter. They cover containers, deployments, Compose projects, volumes, networks, registries, routes and route folders, domains, ACME certificates, certificate authorities, databases and managed databases, storage connections and managed storage, Page Projects, alert rules, and SIEM destinations. A client that retries after a timeout with the same key gets the original result instead of creating a second resource. Operations that return a secret once (tokens, enrollment, keys, credentials) never take the header.

Keys are bound to the API/OAuth token or browser session, its current effective scopes, the method, and the path; results are kept encrypted for 24 hours, and every replay is audited. After a scope change the key starts fresh.

- Same key and same request (query and JSON body): the stored response is replayed with \`${IDEMPOTENCY_REPLAYED_HEADER}: true\`.
- Same key with a different request: \`422 IDEMPOTENCY_KEY_REUSED\`.
- Same key while the first request is still running: \`409 IDEMPOTENCY_KEY_IN_PROGRESS\` with \`Retry-After\`.
- The first request completed but its response was not stored (it looked secret or was over 1 MiB): \`409 IDEMPOTENCY_RESPONSE_WITHHELD\` with the original status and \`Location\` when known; look the resource up instead of retrying.

Only 2xx and deterministic 400, 404, 409, and 422 JSON responses are recorded. 401, 403, 5xx, streamed, and non-JSON responses are not, so a retry runs again. Request bodies over 1 MiB or not JSON run without idempotency, and so do all requests when the idempotency store is unavailable. Remote MCP create tools take an \`idempotencyKey\` argument with the same semantics.`;

const IDEMPOTENCY_KEY_PARAMETER = {
  name: IDEMPOTENCY_KEY_HEADER,
  in: 'header',
  required: false,
  description: `Optional retry key (1-${IDEMPOTENCY_KEY_MAX_LENGTH} printable ASCII characters), bound to your token or session and its current scopes. A retry with the same key and request within 24 hours replays the original response with \`${IDEMPOTENCY_REPLAYED_HEADER}: true\`; a different request under the same key returns 422 IDEMPOTENCY_KEY_REUSED, a retry while the first request still runs returns 409 IDEMPOTENCY_KEY_IN_PROGRESS with Retry-After, and a completed request whose response was not stored returns 409 IDEMPOTENCY_RESPONSE_WITHHELD.`,
  schema: { type: 'string', minLength: 1, maxLength: IDEMPOTENCY_KEY_MAX_LENGTH },
} as const;

type OpenApiOperation = {
  security?: unknown[];
  parameters?: Array<{ $ref?: string; name?: string; in?: string }>;
  [key: string]: unknown;
};

type OpenApiDocumentLike = {
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
  [key: string]: unknown;
};

function documentsIdempotencyKey(operation: OpenApiOperation): boolean {
  if (Array.isArray(operation.security) && operation.security.length === 0) return false;
  return !operation.parameters?.some(
    (parameter) =>
      parameter.$ref === IDEMPOTENCY_KEY_PARAMETER_REF ||
      (parameter.in === 'header' && parameter.name?.toLowerCase() === IDEMPOTENCY_KEY_HEADER.toLowerCase())
  );
}

/** Add the shared Idempotency-Key header parameter to the opt-in create operations that honor it. */
export function withIdempotencyKeyDocumentation<T extends object>(input: T): T {
  const document = input as OpenApiDocumentLike;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    const nextItem: Record<string, unknown> = { ...item };
    for (const method of DOCUMENTED_METHODS) {
      const operation = item[method] as OpenApiOperation | undefined;
      if (!operation || !isIdempotencyEligibleRequest(method, path) || !documentsIdempotencyKey(operation)) continue;
      nextItem[method] = {
        ...operation,
        parameters: [...(operation.parameters ?? []), { $ref: IDEMPOTENCY_KEY_PARAMETER_REF }],
      };
    }
    paths[path] = nextItem;
  }
  const components = document.components ?? {};
  return {
    ...(document as T),
    paths,
    components: {
      ...components,
      parameters: {
        ...((components.parameters as Record<string, unknown> | undefined) ?? {}),
        [IDEMPOTENCY_KEY_PARAMETER_NAME]: IDEMPOTENCY_KEY_PARAMETER,
      },
    },
  };
}
