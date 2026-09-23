import { and, eq, sql } from 'drizzle-orm';
import { container } from '@/container.js';
import { nodes } from '@/db/schema/index.js';
import { SystemCertificateLifecycleService } from '@/services/system-certificate-lifecycle.service.js';
import { type DaemonCertificateIdentity, normalizeCertificateSerial } from './interceptors/auth.js';

export interface EnrolledNodeCertificates {
  certificateSerial: string | null;
  certificateFingerprint: string | null;
  pendingCertificateSerial?: string | null;
  pendingCertificateFingerprint?: string | null;
}

/** Which of the node's enrolled client certificates the caller presented. */
export type NodeCertificateMatch = 'current' | 'pending';

/**
 * A renewed certificate is staged as `pending` until the daemon first
 * registers with it, so both the current and the staged certificate are valid
 * daemon identities. Anything else (superseded, foreign) is rejected.
 */
export function matchEnrolledNodeCertificate(
  node: EnrolledNodeCertificates,
  identity: Pick<DaemonCertificateIdentity, 'serialNumber' | 'certificateFingerprint'>
): NodeCertificateMatch | null {
  const matches = (serial: string | null | undefined, fingerprint: string | null | undefined) =>
    !!serial &&
    normalizeCertificateSerial(serial) === identity.serialNumber &&
    (!identity.certificateFingerprint || fingerprint === identity.certificateFingerprint);
  if (matches(node.certificateSerial, node.certificateFingerprint)) return 'current';
  if (matches(node.pendingCertificateSerial, node.pendingCertificateFingerprint)) return 'pending';
  return null;
}

export class NodeCertificatePromotionConflictError extends Error {
  constructor() {
    super('Staged node certificate changed before it could be promoted');
  }
}

/**
 * Promote the node's staged certificate after the daemon proved possession of
 * it. The previous leaf is revoked only now, in the same transaction that
 * makes the staged serial current. Returns the promoted fingerprint.
 */
export async function promotePendingNodeCertificate(nodeId: string, pendingSerial: string): Promise<string | null> {
  const lifecycle = container.resolve(SystemCertificateLifecycleService);
  let promotedFingerprint: string | null = null;
  await lifecycle.promotePending({ type: 'node', id: nodeId }, pendingSerial, async (tx) => {
    // SET expressions read the pre-update row, so the staged values move into
    // the current columns before the staged columns are cleared.
    const promoted = await tx
      .update(nodes)
      .set({
        certificateSerial: sql`${nodes.pendingCertificateSerial}`,
        certificateFingerprint: sql`${nodes.pendingCertificateFingerprint}`,
        certificateExpiresAt: sql`${nodes.pendingCertificateExpiresAt}`,
        pendingCertificateSerial: null,
        pendingCertificateFingerprint: null,
        pendingCertificateExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(nodes.id, nodeId), eq(nodes.pendingCertificateSerial, pendingSerial)))
      .returning({ certificateFingerprint: nodes.certificateFingerprint });
    if (!promoted.length) throw new NodeCertificatePromotionConflictError();
    promotedFingerprint = promoted[0]!.certificateFingerprint;
  });
  return promotedFingerprint;
}
