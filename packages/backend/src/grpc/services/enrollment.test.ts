import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { createNodeEnrollmentToken } from '@/modules/nodes/node-enrollment-token.js';
import { createEnrollmentHandlers } from './enrollment.js';

const nodeId = '11111111-1111-4111-8111-111111111111';
const expiresAt = new Date('2030-01-01T00:00:00.000Z');

function makeDbNode(
  node: null | { certificateSerial?: string | null; status?: string; hostname?: string },
  updateSet = vi.fn()
) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () =>
            node
              ? [
                  {
                    certificateSerial: 'certificateSerial' in node ? node.certificateSerial : 'aa01',
                    hostname: node.hostname ?? 'node-1',
                    status: node.status ?? 'online',
                  },
                ]
              : []
          ),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value) => {
        updateSet(value);
        return {
          where: vi.fn(async () => undefined),
        };
      }),
    })),
  } as any;
}

function makeThenableRows(rows: any[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: vi.fn(async () => rows),
  });
}

function makeEnrollDb(rows: any[], updateSet = vi.fn()) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => makeThenableRows(rows)),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value) => {
        updateSet(value);
        return {
          where: vi.fn(async () => undefined),
        };
      }),
    })),
  } as any;
}

function makeEnrollCall(token: string) {
  return {
    request: {
      token,
      hostname: 'daemon-host',
      daemonVersion: '1.2.3',
      osInfo: 'linux',
      nginxVersion: '',
      daemonType: 'docker',
    },
  } as any;
}

function makePendingNode(enrollmentTokenHash: string, enrollmentTokenSelector: string | null = null) {
  return {
    id: nodeId,
    type: 'docker',
    hostname: 'pending-node',
    status: 'pending',
    enrollmentTokenHash,
    enrollmentTokenSelector,
  };
}

function makeCall(options: {
  requestedNodeId?: string;
  cn?: string;
  serialNumber?: string;
  authorized?: boolean;
  includeAuthorized?: boolean;
  peer?: string;
}) {
  const socket: Record<string, unknown> = {
    authorizationError: options.authorized === false ? 'SELF_SIGNED_CERT_IN_CHAIN' : null,
    getPeerCertificate: () => ({
      subject: { CN: options.cn ?? nodeId },
      serialNumber: options.serialNumber ?? 'aa01',
    }),
  };
  if (options.includeAuthorized !== false) {
    socket.authorized = options.authorized ?? true;
  }

  return {
    request: { nodeId: options.requestedNodeId ?? nodeId },
    getPeer: () => options.peer ?? '127.0.0.1:50000',
    handler: {
      http2Stream: {
        session: {
          socket,
        },
      },
    },
  } as any;
}

function makeDeps(db: any, connected = true) {
  const commandStream = {
    end: vi.fn(),
    destroy: vi.fn(),
    getPeer: () => '127.0.0.1:12345',
  };
  const logStream = {
    end: vi.fn(),
    destroy: vi.fn(),
  };

  return {
    db,
    commandStream,
    logStream,
    registry: {
      getNode: vi.fn(() =>
        connected
          ? {
              commandStream,
              logStream,
            }
          : null
      ),
      deregister: vi.fn(async () => undefined),
    },
    systemCA: {
      issueNodeCert: vi.fn(
        async (_nodeId: string, _hostname: string, bindCurrent?: (tx: unknown, cert: any) => Promise<void>) => {
          if (bindCurrent) await bindCurrent(db, { id: 'cert-1', serialNumber: 'new01', notAfter: expiresAt });
          return {
            serial: 'new01',
            expiresAt,
            caCertPem: 'ca-cert-pem',
            certPem: 'cert-pem',
            keyPem: 'key-pem',
          };
        }
      ),
    },
    dispatch: {},
    auditService: {
      log: vi.fn(async () => undefined),
    },
    caService: {},
    cryptoService: {},
  } as any;
}

describe('Enroll token lookup', () => {
  it('enrolls a v2 token with a selector lookup and one bcrypt comparison', async () => {
    const enrollmentToken = createNodeEnrollmentToken();
    const tokenHash = await bcrypt.hash(enrollmentToken.token, 4);
    const updateSet = vi.fn();
    const deps = makeDeps(makeEnrollDb([makePendingNode(tokenHash, enrollmentToken.selector)], updateSet));
    const compareSpy = vi.spyOn(bcrypt, 'compare');
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).Enroll(makeEnrollCall(enrollmentToken.token), callback);

    expect(deps.systemCA.issueNodeCert).toHaveBeenCalledWith(nodeId, 'daemon-host', expect.any(Function));
    expect(compareSpy).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'online',
        enrollmentTokenSelector: null,
        enrollmentTokenHash: null,
        certificateSerial: 'new01',
      })
    );
    expect(callback).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        nodeId,
        caCertificate: Buffer.from('ca-cert-pem'),
        clientCertificate: Buffer.from('cert-pem'),
        clientKey: Buffer.from('key-pem'),
      })
    );
    compareSpy.mockRestore();
  });

  it('keeps legacy pending-token compatibility without exiting early', async () => {
    const legacyToken = `gw_node_${'a'.repeat(48)}`;
    const wrongHash = await bcrypt.hash(`gw_node_${'b'.repeat(48)}`, 4);
    const tokenHash = await bcrypt.hash(legacyToken, 4);
    const deps = makeDeps(makeEnrollDb([makePendingNode(wrongHash), makePendingNode(tokenHash)]));
    const compareSpy = vi.spyOn(bcrypt, 'compare');
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).Enroll(makeEnrollCall(legacyToken), callback);

    expect(deps.systemCA.issueNodeCert).toHaveBeenCalledWith(nodeId, 'daemon-host', expect.any(Function));
    expect(compareSpy).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ nodeId }));
    compareSpy.mockRestore();
  });

  it('rejects malformed v2 tokens without bcrypt work', async () => {
    const deps = makeDeps(makeEnrollDb([]));
    const compareSpy = vi.spyOn(bcrypt, 'compare');
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).Enroll(makeEnrollCall('gw_node_v2_bad_selector_secret'), callback);

    expect(deps.systemCA.issueNodeCert).not.toHaveBeenCalled();
    expect(compareSpy).not.toHaveBeenCalled();
    expect(callback.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ code: 16 }));
    compareSpy.mockRestore();
  });

  it('rejects malformed legacy-like tokens without bcrypt work', async () => {
    const deps = makeDeps(makeEnrollDb([]));
    const compareSpy = vi.spyOn(bcrypt, 'compare');
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).Enroll(makeEnrollCall('gw_node_nothex'), callback);

    expect(deps.systemCA.issueNodeCert).not.toHaveBeenCalled();
    expect(compareSpy).not.toHaveBeenCalled();
    expect(callback.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ code: 16 }));
    compareSpy.mockRestore();
  });
});

describe('RenewCertificate daemon certificate identity', () => {
  it('renews a certificate when authorized cert CN and serial match DB', async () => {
    const updateSet = vi.fn();
    const deps = makeDeps(makeDbNode({ certificateSerial: 'AA:01' }, updateSet));
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).RenewCertificate(makeCall({ serialNumber: 'aa01' }), callback);

    expect(deps.systemCA.issueNodeCert).toHaveBeenCalledWith(nodeId, 'node-1', expect.any(Function));
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ certificateSerial: 'new01', certificateExpiresAt: expiresAt })
    );
    expect(callback).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        clientCertificate: Buffer.from('cert-pem'),
        clientKey: Buffer.from('key-pem'),
        certExpiresAt: String(Math.floor(expiresAt.getTime() / 1000)),
      })
    );
    await vi.waitFor(() => {
      expect(deps.registry.deregister).toHaveBeenCalledWith(nodeId, deps.commandStream);
      expect(deps.commandStream.end).toHaveBeenCalled();
      expect(deps.commandStream.destroy).toHaveBeenCalled();
      expect(deps.logStream.end).toHaveBeenCalled();
      expect(deps.logStream.destroy).toHaveBeenCalled();
    });
  });

  it('closes old streams even when deregistration fails after renewal', async () => {
    const deps = makeDeps(makeDbNode({ certificateSerial: 'AA:01' }));
    deps.registry.deregister.mockRejectedValueOnce(new Error('deregister failed'));
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).RenewCertificate(makeCall({ serialNumber: 'aa01' }), callback);

    expect(callback).toHaveBeenCalledWith(null, expect.anything());
    await vi.waitFor(() => {
      expect(deps.commandStream.end).toHaveBeenCalled();
      expect(deps.commandStream.destroy).toHaveBeenCalled();
      expect(deps.logStream.end).toHaveBeenCalled();
      expect(deps.logStream.destroy).toHaveBeenCalled();
    });
  });

  it('rejects renewal when cert serial does not match DB', async () => {
    const deps = makeDeps(makeDbNode({ certificateSerial: 'bb01' }));
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).RenewCertificate(makeCall({ serialNumber: 'aa01' }), callback);

    expect(deps.systemCA.issueNodeCert).not.toHaveBeenCalled();
    expect(callback.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        code: 7,
        message: 'Client certificate is not the current enrolled certificate for this node',
      })
    );
  });

  it('rejects renewal when mTLS authorization state is ambiguous', async () => {
    const deps = makeDeps(makeDbNode({ certificateSerial: 'aa01' }));
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).RenewCertificate(makeCall({ includeAuthorized: false }), callback);

    expect(deps.systemCA.issueNodeCert).not.toHaveBeenCalled();
    expect(callback.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ code: 16 }));
  });

  it('rejects renewal when cert CN does not match requested node', async () => {
    const deps = makeDeps(makeDbNode({ certificateSerial: 'aa01' }));
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).RenewCertificate(
      makeCall({ cn: '22222222-2222-4222-8222-222222222222' }),
      callback
    );

    expect(deps.systemCA.issueNodeCert).not.toHaveBeenCalled();
    expect(callback.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ code: 7 }));
  });

  it('rejects renewal when node has no stored certificate serial', async () => {
    const deps = makeDeps(makeDbNode({ certificateSerial: null }));
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).RenewCertificate(makeCall({ serialNumber: 'aa01' }), callback);

    expect(deps.systemCA.issueNodeCert).not.toHaveBeenCalled();
    expect(callback.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ code: 7 }));
  });

  it('rejects renewal when node is pending', async () => {
    const deps = makeDeps(makeDbNode({ certificateSerial: 'aa01', status: 'pending' }));
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).RenewCertificate(makeCall({ serialNumber: 'aa01' }), callback);

    expect(deps.systemCA.issueNodeCert).not.toHaveBeenCalled();
    expect(callback.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ code: 7 }));
  });
});
