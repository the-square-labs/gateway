import { z } from 'zod';

export const IssueCertificateSchema = z.object({
  caId: z.string().uuid(),
  templateId: z.string().uuid().optional(),
  type: z.enum(['tls-server', 'tls-client', 'code-signing', 'email']),
  commonName: z.string().min(1).max(255),
  sans: z.array(z.string()).default([]),
  keyAlgorithm: z.enum(['rsa-2048', 'rsa-4096', 'ecdsa-p256', 'ecdsa-p384']),
  validityDays: z.number().int().min(1).max(3650),
  subjectDnFields: z
    .object({
      o: z.string().max(255).optional(),
      ou: z.string().max(255).optional(),
      l: z.string().max(255).optional(),
      st: z.string().max(255).optional(),
      c: z.string().max(2).optional(),
    })
    .optional(),
});

export const IssueCertFromCSRSchema = z.object({
  caId: z.string().uuid(),
  templateId: z.string().uuid().optional(),
  type: z.enum(['tls-server', 'tls-client', 'code-signing', 'email']),
  csrPem: z.string().min(1),
  validityDays: z.number().int().min(1).max(3650),
  overrideSans: z.array(z.string()).optional(),
});

export const RevokeCertificateSchema = z.object({
  reason: z
    .enum([
      'unspecified',
      'keyCompromise',
      'caCompromise',
      'affiliationChanged',
      'superseded',
      'cessationOfOperation',
      'certificateHold',
    ])
    .default('unspecified'),
});

export const CertificateListQuerySchema = z.object({
  caId: z.string().uuid().optional(),
  status: z.enum(['active', 'revoked', 'expired']).optional(),
  type: z.enum(['tls-server', 'tls-client', 'code-signing', 'email']).optional(),
  search: z.string().optional(),
  showSystem: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : undefined), z.boolean().optional()),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  sortBy: z.enum(['commonName', 'createdAt', 'notAfter', 'type']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const ExportCertificateQuerySchema = z.object({
  format: z.enum(['pem', 'der', 'pkcs12', 'jks', 'chain', 'fullchain', 'private-key', 'pem-bundle']),
  passphrase: z.string().optional(),
});

export type IssueCertificateInput = z.infer<typeof IssueCertificateSchema>;
export type IssueCertFromCSRInput = z.infer<typeof IssueCertFromCSRSchema>;
export type CertificateListQuery = z.infer<typeof CertificateListQuerySchema>;
