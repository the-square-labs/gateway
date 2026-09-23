import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  accessLists,
  certificateAuthorities,
  certificates,
  nginxTemplates,
  sslCertificates,
} from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';

export interface ProxyReferenceInput {
  sslCertificateId?: string | null;
  internalCertificateId?: string | null;
  accessListId?: string | null;
  nginxTemplateId?: string | null;
}

type ReferenceKey = keyof ProxyReferenceInput;

function forbidden(message: string, requiredScope: string): AppError {
  return new AppError(403, 'FORBIDDEN', message, { requiredScope });
}

/** Only newly set or changed references need authorization; unchanged ones were checked when attached. */
function changedReference(input: ProxyReferenceInput, existing: ProxyReferenceInput | undefined, key: ReferenceKey) {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) return null;
  return existing?.[key] === value ? null : value;
}

/**
 * A proxy route may only attach resources its author can see. Attaching a PKI
 * certificate deploys that certificate's private key to an nginx node, so it
 * needs the same scope as exporting the key.
 */
export async function assertProxyReferenceAccess(
  db: DrizzleClient,
  scopes: string[],
  input: ProxyReferenceInput,
  existing?: ProxyReferenceInput
): Promise<void> {
  const sslCertificateId = changedReference(input, existing, 'sslCertificateId');
  if (sslCertificateId) {
    if (!hasScope(scopes, `ssl:cert:view:${sslCertificateId}`)) {
      throw forbidden('Viewing the selected SSL certificate is required', `ssl:cert:view:${sslCertificateId}`);
    }
    const [certificate] = await db
      .select({ id: sslCertificates.id })
      .from(sslCertificates)
      .where(eq(sslCertificates.id, sslCertificateId))
      .limit(1);
    if (!certificate) throw new AppError(400, 'SSL_CERTIFICATE_NOT_FOUND', 'SSL certificate not found');
  }

  const accessListId = changedReference(input, existing, 'accessListId');
  if (accessListId) {
    if (!hasScope(scopes, `acl:view:${accessListId}`)) {
      throw forbidden('Viewing the selected access list is required', `acl:view:${accessListId}`);
    }
    const [list] = await db
      .select({ id: accessLists.id })
      .from(accessLists)
      .where(eq(accessLists.id, accessListId))
      .limit(1);
    if (!list) throw new AppError(400, 'ACCESS_LIST_NOT_FOUND', 'Access list not found');
  }

  const nginxTemplateId = changedReference(input, existing, 'nginxTemplateId');
  if (nginxTemplateId) {
    if (!hasScope(scopes, `proxy:templates:view:${nginxTemplateId}`)) {
      throw forbidden('Viewing the selected Nginx template is required', `proxy:templates:view:${nginxTemplateId}`);
    }
    const [template] = await db
      .select({ id: nginxTemplates.id })
      .from(nginxTemplates)
      .where(eq(nginxTemplates.id, nginxTemplateId))
      .limit(1);
    if (!template) throw new AppError(400, 'NGINX_TEMPLATE_NOT_FOUND', 'Nginx template not found');
  }

  const internalCertificateId = changedReference(input, existing, 'internalCertificateId');
  if (internalCertificateId) {
    if (!hasScope(scopes, `pki:cert:export:${internalCertificateId}`)) {
      throw forbidden(
        'Deploying a PKI certificate to a proxy route requires permission to export its private key',
        `pki:cert:export:${internalCertificateId}`
      );
    }
    const [certificate] = await db
      .select({
        id: certificates.id,
        status: certificates.status,
        type: certificates.type,
        notAfter: certificates.notAfter,
        hasPrivateKey: certificates.encryptedPrivateKey,
        caIsSystem: certificateAuthorities.isSystem,
      })
      .from(certificates)
      .innerJoin(certificateAuthorities, eq(certificateAuthorities.id, certificates.caId))
      .where(eq(certificates.id, internalCertificateId))
      .limit(1);
    if (!certificate) throw new AppError(400, 'INTERNAL_CERTIFICATE_NOT_FOUND', 'PKI certificate not found');
    if (certificate.caIsSystem) {
      throw new AppError(
        400,
        'INTERNAL_CERTIFICATE_NOT_ALLOWED',
        'Certificates issued by a Gateway system CA cannot be used for proxy routes'
      );
    }
    if (certificate.type !== 'tls-server') {
      throw new AppError(400, 'INTERNAL_CERTIFICATE_NOT_ALLOWED', 'Only TLS server certificates can be used');
    }
    if (certificate.status !== 'active' || (certificate.notAfter && certificate.notAfter.getTime() <= Date.now())) {
      throw new AppError(400, 'INTERNAL_CERTIFICATE_NOT_ALLOWED', 'The PKI certificate is not active');
    }
    if (!certificate.hasPrivateKey) {
      throw new AppError(
        400,
        'INTERNAL_CERTIFICATE_NOT_ALLOWED',
        'The PKI certificate has no Gateway-managed private key to deploy'
      );
    }
  }
}
