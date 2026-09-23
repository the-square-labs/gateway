import { AppError } from '@/middleware/error-handler.js';
import { getAuditRequestContext } from '@/modules/audit/audit-request-context.js';

/** Same code as `IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN` in auth.middleware.ts. */
const IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN = 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN';

type ToolArgs = Record<string, unknown>;

/** Certificate export formats that carry the private key (see ExportCertificateQuerySchema). */
const PRIVATE_KEY_EXPORT_FORMATS: ReadonlySet<unknown> = new Set(['pkcs12', 'jks', 'private-key', 'pem-bundle']);

/**
 * AI tool calls that mint, widen or reveal a credential that outlives the
 * impersonated session. Impersonation lets an administrator act as another
 * user for that session only (see `assertNotImpersonating`), so these are
 * refused while the audit context shows impersonation. Tools run inside the
 * websocket or HTTP audit context, so the check also covers commercial tools.
 */
const CREDENTIAL_TOOL_CALLS: Readonly<Record<string, (args: ToolArgs) => boolean>> = {
  // The API token routes refuse all token management while impersonating.
  manage_api_token: () => true,
  // Widening an OAuth grant extends its refresh token.
  manage_oauth_authorization: (args) => args.operation === 'update_scopes',
  manage_inference_token: (args) => args.operation === 'create',
  // Returns a node enrollment token.
  create_node: () => true,
  manage_pages: (args) => args.operation === 'token_create',
  manage_logging: (args) => args.resource === 'token' && args.operation === 'create',
  manage_managed_storage: (args) => args.action === 'create_access_key',
  manage_database_connection: (args) => args.operation === 'reveal_credentials',
  // Docker webhook rows carry the trigger token; a revealed secret list carries the values.
  manage_docker_container_config: (args) =>
    args.operation === 'get_webhook' ||
    args.operation === 'upsert_webhook' ||
    args.operation === 'regenerate_webhook_token' ||
    (args.operation === 'list_secrets' && Boolean(args.reveal)),
  gitlab_create_deploy_token: () => true,
  // Issuance generates the certificate's private key.
  issue_certificate: () => true,
  manage_certificate: (args) => args.operation === 'export' && PRIVATE_KEY_EXPORT_FORMATS.has(args.format),
};

export function isImpersonationBlockedToolCall(toolName: string, args: ToolArgs): boolean {
  return CREDENTIAL_TOOL_CALLS[toolName]?.(args) ?? false;
}

export function assertToolCallAllowedUnderImpersonation(toolName: string, args: ToolArgs): void {
  if (!getAuditRequestContext()?.impersonation) return;
  if (!isImpersonationBlockedToolCall(toolName, args)) return;
  throw new AppError(
    403,
    IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN,
    'This action creates or reveals a long-lived credential and is unavailable while impersonating'
  );
}
