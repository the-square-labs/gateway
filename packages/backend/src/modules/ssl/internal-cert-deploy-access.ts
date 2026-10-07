import { hasScope } from '@/lib/permissions.js';

/** Puts an internal certificate's private key into service on nginx; pki:cert:export implies it. */
export const INTERNAL_CERT_DEPLOY_SCOPE = 'pki:cert:deploy';

/**
 * Whether the caller may serve an internal PKI certificate through nginx, attached to a Route or linked into the
 * SSL store. Neither ever returns the private key, so this needs pki:cert:deploy on the certificate or on its
 * issuing CA rather than the right to export the key.
 */
export function canDeployInternalCertificate(
  scopes: readonly string[],
  certificateId: string,
  issuingCaId?: string | null
): boolean {
  return (
    hasScope(scopes, `${INTERNAL_CERT_DEPLOY_SCOPE}:${certificateId}`) ||
    (!!issuingCaId && hasScope(scopes, `${INTERNAL_CERT_DEPLOY_SCOPE}:${issuingCaId}`))
  );
}
