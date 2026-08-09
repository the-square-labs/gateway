import { container } from '@/container.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import {
  ExportCertificateQuerySchema,
  IssueCertFromCSRSchema,
  IssueCertificateSchema,
} from '@/modules/pki/cert.schemas.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import { ExportService } from '@/modules/pki/export.service.js';
import { SystemCertificateLifecycleService } from '@/services/system-certificate-lifecycle.service.js';
import type { User } from '@/types.js';
import { agentPage, agentPageLimit, allowedResourceIdsForScopes } from './ai.service-helpers.js';

export const PKI_CERTIFICATE_TOOL_NAMES = new Set([
  'list_certificates',
  'get_certificate',
  'issue_certificate',
  'revoke_certificate',
  'manage_certificate',
  'audit_system_pki_leaves',
]);

export interface PkiCertificateToolContext {
  caService: CAService;
  certService: CertService;
  ensureToolScope(user: User, scope: string): void;
  ensureToolScopeForResource(user: User, baseScope: string, resourceId: string): void;
}

export async function executePkiCertificateTool(
  context: PkiCertificateToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  switch (toolName) {
    case 'audit_system_pki_leaves': {
      context.ensureToolScope(user, 'pki:cert:view');
      context.ensureToolScope(user, 'admin:details:certificates');
      return container
        .resolve(SystemCertificateLifecycleService)
        .auditSystemLeaves(typeof a.caId === 'string' ? a.caId : undefined);
    }
    case 'list_certificates':
      return context.certService.listCertificates(
        {
          caId: a.caId,
          status: a.status,
          search: a.search,
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
          sortBy: 'createdAt',
          sortOrder: 'desc',
        },
        { allowedIds: allowedResourceIdsForScopes(user.scopes, 'pki:cert:view') }
      );
    case 'get_certificate':
      return context.certService.getCertificate(a.certificateId);
    case 'issue_certificate': {
      const certInput = IssueCertificateSchema.parse(args);
      const result = await context.certService.issueCertificate(certInput, user.id);
      return {
        certificate: result.certificate,
        message: 'Certificate issued successfully. Private key was generated.',
      };
    }
    case 'revoke_certificate':
      await context.certService.revokeCertificate(a.certificateId, a.reason, user.id);
      return { success: true, message: 'Certificate revoked.' };
    case 'manage_certificate': {
      if (a.operation === 'issue_from_csr') {
        context.ensureToolScope(user, 'pki:cert:issue');
        return context.certService.issueCertificateFromCSR(IssueCertFromCSRSchema.parse(args), user.id);
      }
      if (a.operation === 'chain') {
        context.ensureToolScopeForResource(user, 'pki:cert:view', String(a.certificateId));
        const cert = await context.certService.getCertificate(a.certificateId);
        const chainPems: string[] = [];
        let currentCaId: string | null = cert.caId;
        while (currentCaId) {
          const ca = await context.caService.getCA(currentCaId);
          chainPems.push(ca.certificatePem);
          currentCaId = ca.parentId;
        }
        return { certificatePem: cert.certificatePem, chainPem: [cert.certificatePem, ...chainPems].join('\n') };
      }
      if (a.operation === 'export') {
        context.ensureToolScopeForResource(user, 'pki:cert:export', String(a.certificateId));
        const input = ExportCertificateQuerySchema.parse(args);
        const cert = await context.certService.getCertificate(a.certificateId);
        const exportService = container.resolve(ExportService);
        if (input.format === 'pem') return { format: 'pem', content: cert.certificatePem };
        if (input.format === 'der') {
          return { format: 'der', contentBase64: exportService.exportDER(cert.certificatePem).toString('base64') };
        }
        if (!input.passphrase) throw new Error('PASSPHRASE_REQUIRED');
        const privateKey = await context.certService.getCertificatePrivateKey(a.certificateId);
        if (input.format === 'pkcs12') {
          if (!privateKey) throw new Error('NO_PRIVATE_KEY');
          return {
            format: 'pkcs12',
            contentBase64: exportService
              .exportPKCS12(cert.certificatePem, privateKey, input.passphrase)
              .toString('base64'),
          };
        }
        return {
          format: 'jks',
          contentBase64: exportService
            .exportJKS(cert.certificatePem, privateKey, input.passphrase, cert.commonName)
            .toString('base64'),
        };
      }
      throw new Error(`Unsupported certificate operation: ${String(a.operation)}`);
    }
    default:
      throw new Error(`Unsupported PKI certificate tool: ${toolName}`);
  }
}
