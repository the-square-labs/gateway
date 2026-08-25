import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import type { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import bcrypt from 'bcryptjs';
import { and, eq, isNull } from 'drizzle-orm';
import { nodes, relayInstances } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { validateEnrollmentDaemonProfile } from '@/modules/nodes/node-daemon-profile.js';
import { parseNodeEnrollmentToken } from '@/modules/nodes/node-enrollment-token.js';
import type { EnrollRequest, EnrollResponse, RenewCertRequest, RenewCertResponse } from '../generated/types.js';
import { extractDaemonCertificateIdentity, normalizeCertificateSerial } from '../interceptors/auth.js';
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

    return (await bcrypt.compare(token, candidate.enrollmentTokenHash)) ? candidate : null;
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

  return matchedNode;
}

export function createEnrollmentHandlers(deps: GrpcServerDeps) {
  return {
    async Enroll(call: ServerUnaryCall<EnrollRequest, EnrollResponse>, callback: sendUnaryData<EnrollResponse>) {
      try {
        const req = call.request;
        logger.info('Enrollment request', { hostname: req.hostname });

        const token = req.token.trim();
        const matchedNode = await findPendingNodeByEnrollmentToken(deps, token);

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
          const [instance] = await deps.db
            .select()
            .from(relayInstances)
            .where(eq(relayInstances.nodeId, nodeId))
            .limit(1);
          if (!instance || !deps.relayPolicy) throw new Error('Relay instance enrollment is not initialized');
          const [trust, server] = await Promise.all([
            deps.relayPolicy.getPolicyEnrollmentTrust(),
            deps.systemCA.issueRelayServerCert(instance.id, instance.advertisedAddresses),
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
          await tx
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
              certificateSerial: certificate.serialNumber,
              certificateFingerprint: certificateFingerprint(certificate.certificatePem),
              certificateExpiresAt: certificate.notAfter,
              hostIdentityId,
              updatedAt: new Date(),
            })
            .where(eq(nodes.id, nodeId));
          if (relayBundle) {
            await tx
              .update(relayInstances)
              .set({
                faultDomainId: hostIdentityId,
                state: 'synchronizing',
                certificateIdentity: relayBundle.serverIdentity,
                certificateFingerprint: relayBundle.serverFingerprint,
                certificateExpiresAt: relayBundle.serverExpiresAt,
                policySigningKeyId: relayBundle.policyKeyId,
                policyPublicKeyFingerprint: relayBundle.policyFingerprint,
                updatedAt: new Date(),
              })
              .where(eq(relayInstances.id, relayBundle.instanceId));
          }
        });

        await deps.auditService.log({
          userId: null,
          action: 'node.enroll',
          resourceType: 'node',
          resourceId: nodeId,
          details: { hostname: req.hostname, type: matchedNode.type, certSerial: certResult.serial },
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
      } catch (err) {
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

        const storedSerial = normalizeCertificateSerial(node.certificateSerial);
        if (storedSerial !== certIdentity.serialNumber) {
          logger.warn('Certificate renewal rejected: certificate serial does not match enrolled node', {
            nodeId: req.nodeId,
            presentedSerial: certIdentity.serialNumber,
            storedSerial,
          });
          callback({ code: 7, message: 'Client certificate is not the current enrolled certificate for this node' });
          return;
        }
        if (
          certIdentity.certificateFingerprint &&
          node.certificateFingerprint !== certIdentity.certificateFingerprint
        ) {
          logger.warn('Certificate renewal rejected: certificate fingerprint does not match enrolled node', {
            nodeId: req.nodeId,
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

        // Atomically change the stored serial with the current-leaf swap.
        const certResult = await deps.systemCA.issueNodeCert(req.nodeId, node.hostname, async (tx, certificate) => {
          await tx
            .update(nodes)
            .set({
              certificateSerial: certificate.serialNumber,
              certificateFingerprint: certificateFingerprint(certificate.certificatePem),
              certificateExpiresAt: certificate.notAfter,
              updatedAt: new Date(),
            })
            .where(eq(nodes.id, req.nodeId));
        });

        logger.info('Node cert renewed', { nodeId: req.nodeId, serial: certResult.serial });
        callback(null, {
          clientCertificate: Buffer.from(certResult.certPem),
          clientKey: Buffer.from(certResult.keyPem),
          certExpiresAt: String(Math.floor(certResult.expiresAt.getTime() / 1000)),
        });
        await deps.relayPolicy
          ?.refreshNodeIdentity(req.nodeId, certificateFingerprint(certResult.certPem))
          .catch((error) => {
            logger.warn('Relay policy identity refresh deferred after certificate renewal', {
              nodeId: req.nodeId,
              error: error instanceof Error ? error.message : String(error),
            });
          });

        // The active CommandStream was authenticated with the old certificate.
        // Remove and close it after returning the renewed cert so the daemon reconnects
        // with credentials matching the newly stored serial.
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
