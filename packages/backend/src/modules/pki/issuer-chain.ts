import { eq } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { certificateAuthorities, certificates } from '@/db/schema/index.js';

/** Bound on the CA hierarchy walk, so a corrupt parent cycle cannot loop forever. */
const MAX_CA_DEPTH = 16;

/**
 * The chain a TLS server sends after a leaf issued by `caId`: the issuing CA
 * and every intermediate above it, without the root that clients already
 * trust. Null when a root CA issued the leaf directly.
 */
export async function loadIssuerChainPem(db: DrizzleExecutor, caId: string): Promise<string | null> {
  const pems: string[] = [];
  let currentId: string | null = caId;
  for (let depth = 0; currentId && depth < MAX_CA_DEPTH; depth += 1) {
    const [ca] = await db
      .select({
        type: certificateAuthorities.type,
        parentId: certificateAuthorities.parentId,
        certificatePem: certificateAuthorities.certificatePem,
      })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.id, currentId))
      .limit(1);
    if (!ca || ca.type !== 'intermediate') break;
    pems.push(ca.certificatePem.trim());
    currentId = ca.parentId;
  }
  return pems.length > 0 ? `${pems.join('\n')}\n` : null;
}

/** Issuer chain of an internal PKI certificate; null when unknown or root-issued. */
export async function loadCertificateIssuerChainPem(
  db: DrizzleExecutor,
  certificateId: string
): Promise<string | null> {
  const [certificate] = await db
    .select({ caId: certificates.caId })
    .from(certificates)
    .where(eq(certificates.id, certificateId))
    .limit(1);
  return certificate ? loadIssuerChainPem(db, certificate.caId) : null;
}
