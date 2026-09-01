import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { sanitizeFilename } from '@/lib/utils.js';
import { requireLicenseFeatureForExistingRuntime } from '@/modules/license/license-policy.middleware.js';
import type { AppEnv } from '@/types.js';
import { CAService } from './ca.service.js';
import { CRLService } from './crl.service.js';
import { publicCaCertificateRoute, publicCrlRoute, publicOcspGetRoute, publicOcspPostRoute } from './public.docs.js';

export const publicPkiRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

publicPkiRoutes.use('*', requireLicenseFeatureForExistingRuntime('internal-pki'));

// Download CRL (DER format, no auth required)
publicPkiRoutes.openapi(publicCrlRoute, async (c) => {
  const crlService = container.resolve(CRLService);
  const caId = c.req.param('caId')!;

  try {
    const crlDer = await crlService.getCRL(caId);
    return new Response(crlDer, {
      headers: {
        'Content-Type': 'application/pkix-crl',
        'Content-Disposition': `attachment; filename="${caId}.crl"`,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch {
    return c.json({ code: 'CRL_ERROR', message: 'Failed to retrieve CRL' }, 500);
  }
});

// OCSP responder (POST — application/ocsp-request)
publicPkiRoutes.openapi(publicOcspPostRoute, async (c) => {
  return c.json({ code: 'OCSP_DISABLED', message: 'OCSP responder is currently disabled' }, 501);
});

// OCSP responder (GET — base64-encoded request in URL)
publicPkiRoutes.openapi(publicOcspGetRoute, async (c) => {
  return c.json({ code: 'OCSP_DISABLED', message: 'OCSP responder is currently disabled' }, 501);
});

// Download CA certificate (PEM, no auth required)
publicPkiRoutes.openapi(publicCaCertificateRoute, async (c) => {
  const caService = container.resolve(CAService);
  const caId = c.req.param('caId')!;

  try {
    const ca = await caService.getCA(caId);
    return new Response(ca.certificatePem, {
      headers: {
        'Content-Type': 'application/x-pem-file',
        'Content-Disposition': `attachment; filename="${sanitizeFilename(ca.commonName)}.pem"`,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return c.json({ code: 'CA_NOT_FOUND', message: 'CA not found' }, 404);
  }
});
