import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { nodes, relayInstances } from '@/db/schema/index.js';
import { createNodeEnrollmentToken } from '@/modules/nodes/node-enrollment-token.js';
import { createEnrollmentHandlers } from './enrollment.js';

const nodeId = '11111111-1111-4111-8111-111111111111';
const expiresAt = new Date('2030-01-01T00:00:00.000Z');
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUPJ9QZSZ8RsM7j4S1caOkw6l2moUwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMZ2F0ZXdheS10ZXN0MB4XDTI2MDQzMDIyMDkxMVoXDTI2
MDUwMTIyMDkxMVowFzEVMBMGA1UEAwwMZ2F0ZXdheS10ZXN0MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEArelepQmlcdBvUBF2jiNGYQqdNR0xNUevpVOD
cefWwKUsUzjbYtXaJV1cPM6icSgVih2AWvdqjlshPwP/0vhVdag2NAs1wiQbAVz5
wZlzWB+5nBDoCPviyqgminQpfQoW3iy6N//jgyTsRZ5rVhGrU9keiO/oZMElKnGk
jI6ulQnnOOxGQFeQQ7CGb3SKMA2RVGV2/8Mw8BiMeqlx0o1JG4gzHrIGcXuW1SJn
jZk0R67d8NbQeb6NzNaTDjCQn4bqt6nWK5eG1juzOeWvCmxD8DMXAHOM9/Ae6ZEn
rv+55CqRJKpP0eJPttkzGv7KU0n5VOclwlUjL/Rty/MFTvu0xQIDAQABo1MwUTAd
BgNVHQ4EFgQUP5K56xgR96eU6esZDGEij/6UBDYwHwYDVR0jBBgwFoAUP5K56xgR
96eU6esZDGEij/6UBDYwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEASzhOsntwv7NsZ69mt3MmU351nV247loOb90kZq4vlwd2Msnf3c4ygUlp61qp
kffbZ/11Xu/jiUI3tbNDGn9X3UigZuOTPRuwN3LIDlPmW+8j7s+IKgwqWakSYbtF
DlcImTDsru1Ie5MpS0zddFjTHwRaLi1R49JpQmGSB625oqs/hizZj+IwsXUvccWb
MHXr0RLyciF6ZNhxUsaNpieDvnlAohnChkMhRF9Wq31QIAtZZtnQDqRzw3uVvV4t
xCpoMT/UAaLKU9twJ0mxAqrxb1eHj66tcC/GDTUIlghn5I42QxS2nE+/5/RHHSrc
oD3IhAwaI3ht9c+zdQt5HFAXSA==
-----END CERTIFICATE-----`;

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
          if (bindCurrent) {
            await bindCurrent(db, {
              id: 'cert-1',
              serialNumber: 'new01',
              certificatePem: TEST_CERT_PEM,
              notAfter: expiresAt,
            });
          }
          return {
            serial: 'new01',
            expiresAt,
            caCertPem: 'ca-cert-pem',
            certPem: TEST_CERT_PEM,
            keyPem: 'key-pem',
          };
        }
      ),
      issueRelayServerCert: vi.fn(async () => ({
        certPem: TEST_CERT_PEM,
        keyPem: 'relay-server-key',
        serial: 'relay01',
        expiresAt,
        identity: 'relay-instance-1',
      })),
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
  it('delivers and binds the relay server identity and pinned policy trust during enrollment', async () => {
    const enrollmentToken = createNodeEnrollmentToken();
    const tokenHash = await bcrypt.hash(enrollmentToken.token, 4);
    const hostIdentityId = '22222222-2222-4222-8222-222222222222';
    const instanceId = '33333333-3333-4333-8333-333333333333';
    const updates: unknown[] = [];
    const pending = { ...makePendingNode(tokenHash, enrollmentToken.selector), type: 'relay' };
    const instance = {
      id: instanceId,
      nodeId,
      poolId: 'system',
      advertisedAddresses: ['relay.example.test'],
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () => ({ limit: async () => (table === nodes ? [pending] : table === relayInstances ? [instance] : []) }),
        }),
      })),
      update: vi.fn(() => ({
        set: (value: unknown) => {
          updates.push(value);
          return { where: vi.fn(async () => undefined) };
        },
      })),
    } as any;
    const deps = makeDeps(db);
    deps.relayPolicy = {
      getPolicyEnrollmentTrust: vi.fn(async () => ({
        keyId: 'policy-key-1',
        publicKey: Buffer.alloc(32, 7),
        fingerprint: `sha256:${'a'.repeat(64)}`,
      })),
      refreshNodeIdentity: vi.fn(async () => undefined),
    };
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).Enroll(
      {
        request: {
          token: enrollmentToken.token,
          hostname: 'relay-host',
          daemonVersion: '1.2.3',
          osInfo: 'linux/amd64',
          nginxVersion: '',
          daemonType: 'relay',
          hostIdentityId,
        },
      } as any,
      callback
    );

    expect(deps.systemCA.issueRelayServerCert).toHaveBeenCalledWith(instanceId, ['relay.example.test']);
    expect(updates).toContainEqual(expect.objectContaining({ hostIdentityId, certificateSerial: 'new01' }));
    expect(updates).toContainEqual(
      expect.objectContaining({
        faultDomainId: hostIdentityId,
        state: 'synchronizing',
        certificateIdentity: 'relay-instance-1',
        policySigningKeyId: 'policy-key-1',
      })
    );
    expect(callback).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        relayPoolId: 'system',
        relayInstanceId: instanceId,
        policySigningKeyId: 'policy-key-1',
        policySigningPublicKey: Buffer.alloc(32, 7),
        relayServerCertificate: Buffer.from(TEST_CERT_PEM),
        relayServerKey: Buffer.from('relay-server-key'),
        relayServerIdentity: 'relay-instance-1',
      })
    );
  });

  it('enrolls a v2 token with a selector lookup and one bcrypt comparison', async () => {
    const enrollmentToken = createNodeEnrollmentToken();
    const tokenHash = await bcrypt.hash(enrollmentToken.token, 4);
    const updateSet = vi.fn();
    const deps = makeDeps(makeEnrollDb([makePendingNode(tokenHash, enrollmentToken.selector)], updateSet));
    deps.relayPolicy = { refreshNodeIdentity: vi.fn().mockRejectedValue(new Error('relay unavailable')) };
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
        clientCertificate: Buffer.from(TEST_CERT_PEM),
        clientKey: Buffer.from('key-pem'),
      })
    );
    expect(callback).toHaveBeenCalledTimes(1);
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
    deps.relayPolicy = { refreshNodeIdentity: vi.fn().mockRejectedValue(new Error('relay unavailable')) };
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).RenewCertificate(makeCall({ serialNumber: 'aa01' }), callback);

    expect(deps.systemCA.issueNodeCert).toHaveBeenCalledWith(nodeId, 'node-1', expect.any(Function));
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ certificateSerial: 'new01', certificateExpiresAt: expiresAt })
    );
    expect(callback).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        clientCertificate: Buffer.from(TEST_CERT_PEM),
        clientKey: Buffer.from('key-pem'),
        certExpiresAt: String(Math.floor(expiresAt.getTime() / 1000)),
      })
    );
    expect(callback).toHaveBeenCalledTimes(1);
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
