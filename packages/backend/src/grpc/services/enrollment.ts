import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import type { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import bcrypt from 'bcryptjs';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { nodes, relayInstances } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { validateEnrollmentDaemonProfile } from '@/modules/nodes/node-daemon-profile.js';
import { isNodeEnrollmentTokenExpired, parseNodeEnrollmentToken } from '@/modules/nodes/node-enrollment-token.js';
import { bumpRelayPolicyRevision } from '@/services/relay-policy-reconciler.js';
import type { EnrollRequest, EnrollResponse, RenewCertRequest, RenewCertResponse } from '../generated/types.js';
import { extractDaemonCertificateIdentity, normalizeCertificateSerial } from '../interceptors/auth.js';
import { matchEnrolledNodeCertificate } from '../node-certificate.js';
import type { GrpcServerDeps } from '../server.js';

const logger = createChildLogger('GrpcEnrollment');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function certificateFingerprint(certificatePem: string): string {
  const certificate = new X509Certificate(certificatePem);
  return `sha256:${createHash('sha256').update(certificate.raw).digest('hex')}`;
}

async function findPendingNodeByEnrollmentToken(deps: GrpcServerDeps, token: string) {
  const parsedToken = parseNodeEnrollmentToken(token);

  if (parsedToken.kind === 'v2') {
    const [candidate] = await deps.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.status, 'pending'), eq(nodes.enrollmentTokenSelector, parsedToken.selector)))
      .limit(1);

    if (!candidate?.enrollmentTokenHash) {
      return null;
    }

    if (!(await bcrypt.compare(token, candidate.enrollmentTokenHash))) return null;
    return isNodeEnrollmentTokenExpired(candidate.enrollmentTokenExpiresAt) ? 'expired' : candidate;
  }

  if (parsedToken.kind !== 'legacy') {
    return null;
  }

  // Compatibility for pending nodes created before selector-based tokens.
  const legacyPendingNodes = await deps.db
    .select()
    .from(nodes)
    .where(and(eq(nodes.status, 'pending'), isNull(nodes.enrollmentTokenSelector)));

  let matchedNode = null;
  for (const node of legacyPendingNodes) {
    if (node.enrollmentTokenHash && (await bcrypt.compare(token, node.enrollmentTokenHash))) {
      if (!matchedNode) {
        matchedNode = node;
      }
    }
    // Compare every legacy candidate to avoid turning old tokens into a position oracle.
  }

  if (matchedNode && isNodeEnrollmentTokenExpired(matchedNode.enrollmentTokenExpiresAt)) return 'expired';
  return matchedNode;
}

/**
 * A re-enrollment token of an enrolled remote relay (RelayPoolService.issueRelayReenrollment).
 * The token is the authorization, exactly as for a first enrollment: single use, expiring, and
 * handed to the host by an administrator. It lets a relay whose pinned policy trust holds only
 * keys Gateway destroyed start over from the active key without leaving the pool.
 */
async function findRelayNodeByReenrollmentToken(deps: GrpcServerDeps, token: string) {
  const parsedToken = parseNodeEnrollmentToken(token);
  if (parsedToken.kind !== 'v2') return null;
  const [candidate] = await deps.db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.type, 'relay'),
        ne(nodes.status, 'pending'),
        isNotNull(nodes.certificateSerial),
        eq(nodes.enrollmentTokenSelector, parsedToken.selector)
      )
    )
    .limit(1);
  if (!candidate?.enrollmentTokenHash) return null;
  if (!(await bcrypt.compare(token, candidate.enrollmentTokenHash))) return null;
  return isNodeEnrollmentTokenExpired(candidate.enrollmentTokenExpiresAt) ? 'expired' : candidate;
}

class EnrollmentTokenConsumedError extends Error {
  constructor() {
    super('Enrollment token was already used');
  }
}

export function createEnrollmentHandlers(deps: GrpcServerDeps) {
  return {
    async Enroll(call: ServerUnaryCall<EnrollRequest, EnrollResponse>, callback: sendUnaryData<EnrollResponse>) {
      try {
        const req = call.request;
        logger.info('Enrollment request', { hostname: req.hostname });

        const token = req.token.trim();
        const matchedNode =
          (await findPendingNodeByEnrollmentToken(deps, token)) ??
          (await findRelayNodeByReenrollmentToken(deps, token));
        const relayReenrollment = matchedNode !== null && matchedNode !== 'expired' && matchedNode.status !== 'pending';

        if (matchedNode === 'expired') {
          callback({ code: 16, message: 'Enrollment token has expired; generate a new token for this node' });
          return;
        }
        if (!matchedNode) {
          callback({ code: 16, message: 'Invalid enrollment token' });
          return;
        }

        const nodeId = matchedNode.id;
        const profileError = validateEnrollmentDaemonProfile(matchedNode.type, req.daemonType);
        if (profileError) {
          callback({ code: 7, message: profileError });
          return;
        }
        if (matchedNode.type === 'relay' && req.daemonType !== 'relay') {
          callback({ code: 7, message: 'Relay node enrollment requires relay supervisor identity' });
          return;
        }
        const requestedHostIdentityId = req.hostIdentityId?.trim();
        if (matchedNode.type === 'relay' && (!requestedHostIdentityId || !UUID_PATTERN.test(requestedHostIdentityId))) {
          callback({ code: 3, message: 'A valid persisted host identity is required' });
          return;
        }
        if (requestedHostIdentityId && !UUID_PATTERN.test(requestedHostIdentityId)) {
          callback({ code: 3, message: 'Persisted host identity is invalid' });
          return;
        }
        // Released daemons predate host_identity_id. Preserve backend-first
        // enrollment compatibility for those roles; once upgraded they report
        // the installer-persisted shared identity on subsequent installs.
        const hostIdentityId = requestedHostIdentityId || matchedNode.hostIdentityId || randomUUID();

        let relayBundle:
          | {
              instanceId: string;
              poolId: string;
              policyKeyId: string;
              policyPublicKey: Buffer;
              policyFingerprint: string;
              serverCertificate: Buffer;
              serverKey: Buffer;
              serverIdentity: string;
              serverFingerprint: string;
              serverExpiresAt: Date;
            }
          | undefined;
        if (matchedNode.type === 'relay') {
          let [instance] = await deps.db
            .select()
            .from(relayInstances)
            .where(eq(relayInstances.nodeId, nodeId))
            .limit(1);
          if (!deps.relayPolicy) throw new Error('Relay instance enrollment is not initialized');
          const advertisedAddresses = instance?.advertisedAddresses ?? matchedNode.serviceAddresses ?? [];
          if (!advertisedAddresses.length) throw new Error('Relay node has no advertised service address');
          if (!instance) {
            [instance] = await deps.db
              .insert(relayInstances)
              .values({
                poolId: 'system',
                kind: 'remote',
                nodeId,
                faultDomainId: hostIdentityId,
                displayName: matchedNode.displayName?.trim() ?? req.hostname,
                advertisedAddresses,
                servicePort: 9443,
                state: 'joining',
              })
              .returning();
          }
          if (!instance) throw new Error('Relay instance enrollment could not be initialized');
          const [trust, server] = await Promise.all([
            deps.relayPolicy.getPolicyEnrollmentTrust(),
            deps.systemCA.issueRelayServerCert(instance.id, advertisedAddresses),
          ]);
          relayBundle = {
            instanceId: instance.id,
            poolId: instance.poolId,
            policyKeyId: trust.keyId,
            policyPublicKey: trust.publicKey,
            policyFingerprint: trust.fingerprint,
            serverCertificate: Buffer.from(server.certPem),
            serverKey: Buffer.from(server.keyPem),
            serverIdentity: server.identity,
            serverFingerprint: certificateFingerprint(server.certPem),
            serverExpiresAt: server.expiresAt,
          };
        }

        // The node serial update is committed with the system-leaf ownership
        // swap. If this update fails, the prior current certificate remains
        // usable and the newly issued unbound leaf is never auto-cleaned.
        const certResult = await deps.systemCA.issueNodeCert(nodeId, req.hostname, async (tx, certificate) => {
          // Bind only while this exact token is still pending: a concurrent
          // enrollment with the same token must not also receive a bundle.
          const bound = await tx
            .update(nodes)
            .set({
              status: 'online',
              hostname: req.hostname,
              daemonVersion: req.daemonVersion,
              osInfo: req.osInfo,
              capabilities: {
                ...(req.nginxVersion ? { nginxVersion: req.nginxVersion } : {}),
                ...(req.daemonType ? { daemonType: req.daemonType } : {}),
              },
              lastSeenAt: new Date(),
              enrollmentTokenSelector: null,
              enrollmentTokenHash: null,
              enrollmentTokenExpiresAt: null,
              certificateSerial: certificate.serialNumber,
              certificateFingerprint: certificateFingerprint(certificate.certificatePem),
              certificateExpiresAt: certificate.notAfter,
              pendingCertificateSerial: null,
              pendingCertificateFingerprint: null,
              pendingCertificateExpiresAt: null,
              hostIdentityId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(nodes.id, nodeId),
                relayReenrollment
                  ? and(eq(nodes.type, 'relay'), ne(nodes.status, 'pending'))
                  : eq(nodes.status, 'pending'),
                eq(nodes.enrollmentTokenHash, matchedNode.enrollmentTokenHash!),
                matchedNode.enrollmentTokenSelector
                  ? eq(nodes.enrollmentTokenSelector, matchedNode.enrollmentTokenSelector)
                  : isNull(nodes.enrollmentTokenSelector)
              )
            )
            .returning({ id: nodes.id });
          if (bound.length === 0) throw new EnrollmentTokenConsumedError();
          if (relayBundle) {
            const relayValues = {
              faultDomainId: hostIdentityId,
              state: 'synchronizing' as const,
              certificateIdentity: relayBundle.serverIdentity,
              certificateFingerprint: relayBundle.serverFingerprint,
              certificateExpiresAt: relayBundle.serverExpiresAt,
              policySigningKeyId: relayBundle.policyKeyId,
              policyPublicKeyFingerprint: relayBundle.policyFingerprint,
              // The supervisor starts its worker over from the enrollment key: forget the trust
              // and the policy sequence the relay reported before.
              appliedPolicyRevision: 0,
              policyExpiresAt: null,
              health: sql`coalesce(${relayInstances.health}, '{}'::jsonb) - 'policySigningKeyIds' - 'lastError'`,
              updatedAt: new Date(),
            };
            await tx.update(relayInstances).set(relayValues).where(eq(relayInstances.id, relayBundle.instanceId));
            // A re-enrolled relay serves only its new certificate. Daemons pin the certificate
            // from their grant bundles, so the change must reach them (see the refresh below).
            if (relayReenrollment) await bumpRelayPolicyRevision(tx);
          }
        });

        await deps.auditService.log({
          userId: null,
          action: 'node.enroll',
          resourceType: 'node',
          resourceId: nodeId,
          details: {
            hostname: req.hostname,
            type: matchedNode.type,
            certSerial: certResult.serial,
            ...(relayReenrollment ? { reenrollment: true } : {}),
          },
        });

        logger.info('Node enrolled with PKI cert', { nodeId, hostname: req.hostname, serial: certResult.serial });
        callback(null, {
          nodeId,
          caCertificate: Buffer.from(certResult.caCertPem),
          clientCertificate: Buffer.from(certResult.certPem),
          clientKey: Buffer.from(certResult.keyPem),
          certExpiresAt: String(Math.floor(certResult.expiresAt.getTime() / 1000)),
          hostIdentityId,
          relayPoolId: relayBundle?.poolId ?? '',
          relayInstanceId: relayBundle?.instanceId ?? '',
          policySigningKeyId: relayBundle?.policyKeyId ?? '',
          policySigningPublicKey: relayBundle?.policyPublicKey ?? Buffer.alloc(0),
          policySigningPublicKeyFingerprint: relayBundle?.policyFingerprint ?? '',
          relayServerCertificate: relayBundle?.serverCertificate ?? Buffer.alloc(0),
          relayServerKey: relayBundle?.serverKey ?? Buffer.alloc(0),
          relayServerIdentity: relayBundle?.serverIdentity ?? '',
        });
        await deps.relayPolicy
          ?.refreshNodeIdentity(nodeId, certificateFingerprint(certResult.certPem))
          .catch((error) => {
            logger.warn('Relay policy identity refresh deferred after enrollment', {
              nodeId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        if (relayReenrollment && relayBundle) {
          // Daemons pinning the relay's previous certificate cannot reach it any more: hand them
          // the new one now rather than at their next scheduled refresh.
          await deps.relayPolicy?.refreshAllNodeGrantsIfDue(true).catch((error) => {
            logger.warn('Relay re-enrolled; daemon grant bundles follow on the next refresh', {
              nodeId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      } catch (err) {
        if (err instanceof EnrollmentTokenConsumedError) {
          callback({ code: 16, message: 'Invalid enrollment token' });
          return;
        }
        if ((err as { constraint?: string }).constraint === 'relay_instances_pool_fault_domain_unique') {
          callback({ code: 6, message: 'This physical host already has a relay instance in the system pool' });
          return;
        }
        logger.error('Enrollment failed', { error: (err as Error).message });
        callback({ code: 13, message: `Enrollment failed: ${(err as Error).message}` });
      }
    },

    async RenewCertificate(
      call: ServerUnaryCall<RenewCertRequest, RenewCertResponse>,
      callback: sendUnaryData<RenewCertResponse>
    ) {
      try {
        const req = call.request;
        logger.info('Certificate renewal request', { nodeId: req.nodeId });

        const certIdentity = extractDaemonCertificateIdentity(call as any);
        if (!certIdentity) {
          callback({ code: 16, message: 'Authorized mTLS client certificate is required for certificate renewal' });
          return;
        }
        if (certIdentity.nodeId !== req.nodeId) {
          logger.warn('Certificate renewal rejected: cert CN does not match requested nodeId', {
            certNodeId: certIdentity.nodeId,
            requestedNodeId: req.nodeId,
          });
          callback({ code: 7, message: 'Client certificate does not match requested node' });
          return;
        }

        // Verify the caller is authenticated — must be a registered (non-pending) node
        const [node] = await deps.db.select().from(nodes).where(eq(nodes.id, req.nodeId)).limit(1);

        if (!node) {
          callback({ code: 5, message: 'Node not found' });
          return;
        }

        // Only enrolled nodes (with an existing cert serial) can renew
        if (!node.certificateSerial) {
          callback({ code: 7, message: 'Node has not been enrolled yet' });
          return;
        }

        // Reject if node is in pending status (never completed enrollment)
        if (node.status === 'pending') {
          callback({ code: 7, message: 'Node enrollment not complete' });
          return;
        }

        // The staged (pending) certificate is accepted too: a daemon that
        // saved it but has not re-registered yet can still retry.
        if (!matchEnrolledNodeCertificate(node, certIdentity)) {
          logger.warn('Certificate renewal rejected: certificate does not match enrolled node', {
            nodeId: req.nodeId,
            presentedSerial: certIdentity.serialNumber,
            storedSerial: normalizeCertificateSerial(node.certificateSerial),
          });
          callback({ code: 7, message: 'Client certificate is not the current enrolled certificate for this node' });
          return;
        }

        // Verify the requesting node is currently connected via CommandStream
        // (proves it holds a valid mTLS cert from the system CA)
        const connectedNode = deps.registry.getNode(req.nodeId);
        if (!connectedNode) {
          callback({ code: 7, message: 'Node must be connected to renew certificate' });
          return;
        }

        // Verify the renewal call originates from the same network peer as the
        // authenticated CommandStream — prevents cross-node cert impersonation
        const renewPeer = call.getPeer().replace(/:\d+$/, ''); // strip ephemeral port
        const streamPeer = connectedNode.commandStream.getPeer().replace(/:\d+$/, '');
        if (renewPeer !== streamPeer) {
          logger.warn('Cert renewal from different peer than connected stream', {
            nodeId: req.nodeId,
            renewPeer: call.getPeer(),
            streamPeer: connectedNode.commandStream.getPeer(),
          });
          callback({ code: 7, message: 'Renewal must originate from the connected node' });
          return;
        }

        // Stage the renewed certificate as pending. The current certificate
        // stays valid (and unrevoked) until the daemon registers with the new
        // one, so a lost response or a failed write on the node cannot lock it
        // out. A retry while a staged certificate exists returns that same one.
        const currentSerial = node.certificateSerial;
        const certResult = await deps.systemCA.issueNodeCert(
          req.nodeId,
          node.hostname,
          async (tx, certificate) => {
            const staged = await tx
              .update(nodes)
              .set({
                pendingCertificateSerial: certificate.serialNumber,
                pendingCertificateFingerprint: certificateFingerprint(certificate.certificatePem),
                pendingCertificateExpiresAt: certificate.notAfter,
                updatedAt: new Date(),
              })
              .where(and(eq(nodes.id, req.nodeId), eq(nodes.certificateSerial, currentSerial)))
              .returning({ id: nodes.id });
            if (staged.length === 0) throw new Error('Node certificate changed during renewal; retry');
          },
          { stage: 'pending' }
        );

        logger.info('Node cert renewal staged', { nodeId: req.nodeId, serial: certResult.serial });
        callback(null, {
          clientCertificate: Buffer.from(certResult.certPem),
          clientKey: Buffer.from(certResult.keyPem),
          certExpiresAt: String(Math.floor(certResult.expiresAt.getTime() / 1000)),
        });

        // The active CommandStream was authenticated with the old certificate.
        // Remove and close it after returning the renewed cert so the daemon
        // reconnects with it; that registration promotes the staged serial.
        deps.registry.deregister(req.nodeId, connectedNode.commandStream).catch((deregisterErr) => {
          logger.warn('Failed to deregister command stream after cert renewal', {
            nodeId: req.nodeId,
            error: deregisterErr instanceof Error ? deregisterErr.message : String(deregisterErr),
          });
        });

        for (const [kind, stream] of [
          ['log', connectedNode.logStream],
          ['command', connectedNode.commandStream],
        ] as const) {
          if (!stream) continue;
          try {
            stream.end();
          } catch (streamErr) {
            logger.warn(`Failed to end ${kind} stream after cert renewal`, {
              nodeId: req.nodeId,
              error: streamErr instanceof Error ? streamErr.message : String(streamErr),
            });
          }
          try {
            (stream as any).destroy?.();
          } catch (streamErr) {
            logger.warn(`Failed to destroy ${kind} stream after cert renewal`, {
              nodeId: req.nodeId,
              error: streamErr instanceof Error ? streamErr.message : String(streamErr),
            });
          }
        }
      } catch (err) {
        logger.error('Certificate renewal failed', { error: (err as Error).message });
        callback({ code: 13, message: `Renewal failed: ${(err as Error).message}` });
      }
    },
  };
}
