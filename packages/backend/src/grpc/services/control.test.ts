import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createControlHandlers, diffDockerContainerStateReports, mapGpuHealthDevices } from './control.js';

vi.mock('@/config/env.js', () => ({
  getEnv: () => ({ APP_VERSION: 'dev' }),
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn(() => ({
      clearNodeUpdateInProgressOnReconnect: vi.fn(),
      resyncAllHostsOnNode: vi.fn(),
      evaluateHealthReport: vi.fn().mockResolvedValue(undefined),
      observeStatefulEvent: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

vi.mock('@/services/daemon-update.service.js', () => ({
  DaemonUpdateService: class DaemonUpdateService {},
}));

const nodeId = '11111111-1111-4111-8111-111111111111';

function makeDbNode(
  node: null | { type?: string; configVersionHash?: string | null; certificateSerial?: string | null; status?: string }
) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () =>
            node
              ? [
                  {
                    type: node.type ?? 'nginx',
                    configVersionHash: node.configVersionHash ?? null,
                    certificateSerial: 'certificateSerial' in node ? node.certificateSerial : 'aa01',
                    status: node.status ?? 'online',
                  },
                ]
              : []
          ),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
  } as any;
}

function makeDelayedDbNode(
  node: null | { type?: string; configVersionHash?: string | null; certificateSerial?: string | null; status?: string }
) {
  let resolveRows!: (
    rows: Array<{
      type: string;
      configVersionHash: string | null;
      certificateSerial: string | null;
      status: string;
    }>
  ) => void;
  const rowsPromise = new Promise<
    Array<{
      type: string;
      configVersionHash: string | null;
      certificateSerial: string | null;
      status: string;
    }>
  >((resolve) => {
    resolveRows = resolve;
  });

  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => rowsPromise),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => undefined),
        })),
      })),
    } as any,
    resolveRows: () =>
      resolveRows(
        node
          ? [
              {
                type: node.type ?? 'nginx',
                configVersionHash: node.configVersionHash ?? null,
                certificateSerial: 'certificateSerial' in node ? (node.certificateSerial ?? null) : 'aa01',
                status: node.status ?? 'online',
              },
            ]
          : []
      ),
  };
}

function makeQueuedDbNode(
  node: null | { type?: string; configVersionHash?: string | null; certificateSerial?: string | null; status?: string }
) {
  const resolvers: Array<() => void> = [];
  const rowsPromise = () =>
    new Promise<
      Array<{
        type: string;
        configVersionHash: string | null;
        certificateSerial: string | null;
        status: string;
      }>
    >((resolve) => {
      resolvers.push(() => {
        resolve(
          node
            ? [
                {
                  type: node.type ?? 'nginx',
                  configVersionHash: node.configVersionHash ?? null,
                  certificateSerial: 'certificateSerial' in node ? (node.certificateSerial ?? null) : 'aa01',
                  status: node.status ?? 'online',
                },
              ]
            : []
        );
      });
    });

  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(rowsPromise),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => undefined),
        })),
      })),
    } as any,
    resolveNext: () => resolvers.shift()?.(),
  };
}

function makeDbNodeWithFailingRegistrationMetadataUpdate() {
  let updateCount = 0;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [
            {
              type: 'nginx',
              configVersionHash: null,
              certificateSerial: 'aa01',
              status: 'online',
            },
          ]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => {
          updateCount += 1;
          if (updateCount === 1) throw new Error('metadata update failed');
        }),
      })),
    })),
  } as any;
}

function makeStream(options: {
  cn?: string;
  serialNumber?: string;
  authorized?: boolean;
  includeAuthorized?: boolean;
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

  return Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    getPeer: () => '127.0.0.1:12345',
    handler: {
      http2Stream: {
        session: {
          socket,
        },
      },
    },
  }) as any;
}

function makeDeps(db: any) {
  let connectedNode: { commandStream: unknown } | undefined;
  return {
    db,
    registry: {
      register: vi.fn(
        async (_nodeId: string, type: string, hostname: string, _hash: string, commandStream: unknown) => {
          connectedNode = { commandStream, type, hostname } as any;
        }
      ),
      deregister: vi.fn(async (_nodeId: string, commandStream?: unknown) => {
        if (!commandStream || connectedNode?.commandStream === commandStream) connectedNode = undefined;
      }),
      getNode: vi.fn(() => connectedNode),
      handleCommandResult: vi.fn(),
      handleLogStream: vi.fn(),
      updateHealthReport: vi.fn(),
    },
    dispatch: {},
    auditService: { log: vi.fn(async () => undefined) },
    caService: {},
    cryptoService: {},
    systemCA: {},
  } as any;
}

async function emitRegister(stream: EventEmitter & { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }) {
  stream.emit('data', {
    register: {
      nodeId,
      hostname: 'node-1',
      nginxVersion: '1.27.0',
      configVersionHash: 'hash-daemon',
      daemonVersion: 'dev',
      nginxUptimeSeconds: '10',
      nginxRunning: true,
      cpuModel: 'cpu',
      cpuCores: 2,
      architecture: 'x64',
      kernelVersion: '6.0',
      daemonType: 'nginx',
      capabilities: [],
    },
  });
  await vi.waitFor(() => {
    expect(stream.end.mock.calls.length + stream.write.mock.calls.length).toBeGreaterThan(0);
  });
}

describe('diffDockerContainerStateReports', () => {
  it('does not emit an exited change for an old ID when the same container name was recreated', () => {
    const changes = diffDockerContainerStateReports(
      [{ containerId: 'old-id', name: 'web', state: 'running' }],
      [{ containerId: 'new-id', name: 'web', state: 'running' }]
    );

    expect(changes).toEqual([{ containerId: 'new-id', name: 'web', state: 'running' }]);
  });

  it('emits an exited change when a container disappears without a same-name replacement', () => {
    const changes = diffDockerContainerStateReports([{ containerId: 'old-id', name: 'worker', state: 'running' }], []);

    expect(changes).toEqual([{ containerId: 'old-id', name: 'worker', state: 'exited' }]);
  });

  it('emits a change when the same container ID changes state', () => {
    const changes = diffDockerContainerStateReports(
      [{ containerId: 'same-id', name: 'api', state: 'running' }],
      [{ containerId: 'same-id', name: 'api', state: 'exited' }]
    );

    expect(changes).toEqual([{ containerId: 'same-id', name: 'api', state: 'exited' }]);
  });
});

describe('mapGpuHealthDevices', () => {
  it('preserves reported zero GPU values and drops fields not explicitly reported', () => {
    const devices = mapGpuHealthDevices([
      {
        id: 'nvidia:gpu-1',
        vendor: 'nvidia',
        model: 'RTX 3050',
        pciAddress: '0000:01:00.0',
        deviceIndex: 0,
        attachable: true,
        availableMetrics: ['utilization_percent', 'memory_total_bytes', 'memory_used_bytes', 'throttled'],
        utilizationPercent: 0,
        memoryTotalBytes: '8589934592',
        memoryUsedBytes: '0',
        throttled: false,
        temperatureCelsius: 0,
      },
    ]);

    expect(devices).toEqual([
      expect.objectContaining({
        id: 'nvidia:gpu-1',
        utilizationPercent: 0,
        memoryTotalBytes: 8_589_934_592,
        memoryUsedBytes: 0,
        throttled: false,
        availableMetrics: ['utilization_percent', 'memory_total_bytes', 'memory_used_bytes', 'throttled'],
      }),
    ]);
    expect(devices[0]).not.toHaveProperty('temperatureCelsius');
  });

  it('does not persist a proto scalar when its metric marker is missing or invalid', () => {
    const [device] = mapGpuHealthDevices([
      {
        id: 'intel:0000:00:02.0',
        availableMetrics: ['utilization_percent', 'temperature_celsius'],
        utilizationPercent: 61,
        temperatureCelsius: 'not-a-number',
      },
    ]);

    expect(device).toMatchObject({
      utilizationPercent: 61,
      availableMetrics: ['utilization_percent'],
    });
    expect(device).not.toHaveProperty('temperatureCelsius');
  });
});

describe('CommandStream daemon certificate identity', () => {
  it('stores docker daemon engine version under dockerVersion capabilities', async () => {
    const setMetadata = vi.fn((_metadata: { capabilities: Record<string, unknown> }) => ({
      where: vi.fn(async () => undefined),
    }));
    const db = {
      ...makeDbNode({ type: 'docker' }),
      update: vi.fn(() => ({
        set: setMetadata,
      })),
    } as any;
    const deps = makeDeps(db);
    const stream = makeStream({ serialNumber: 'aa01' });

    createControlHandlers(deps).CommandStream(stream);
    stream.emit('data', {
      register: {
        nodeId,
        hostname: 'docker-1',
        nginxVersion: '27.5.1',
        configVersionHash: 'hash-daemon',
        daemonVersion: 'dev',
        cpuModel: 'cpu',
        cpuCores: 2,
        architecture: 'x64',
        kernelVersion: '6.0',
        daemonType: 'docker',
        capabilities: ['docker_deployments_v1', 'docker_gpu_v1'],
      },
    });

    await vi.waitFor(() => expect(setMetadata).toHaveBeenCalled());

    const metadata = setMetadata.mock.calls[0][0];
    expect(metadata.capabilities).toMatchObject({
      daemonType: 'docker',
      dockerVersion: '27.5.1',
      dockerDeploymentsV1: true,
      dockerGpuV1: true,
    });
    expect(metadata.capabilities).not.toHaveProperty('nginxVersion');
  });

  it('registers a node when authorized cert CN and serial match DB', async () => {
    const db = makeDbNode({ certificateSerial: 'AA:01' });
    const deps = makeDeps(db);
    const stream = makeStream({ serialNumber: 'aa01' });

    createControlHandlers(deps).CommandStream(stream);
    await emitRegister(stream);

    expect(deps.registry.register).toHaveBeenCalledWith(
      nodeId,
      'nginx',
      'node-1',
      'hash-daemon',
      expect.anything(),
      expect.objectContaining({ isCurrentRegistration: expect.any(Function) })
    );
  });

  it('preserves interface, local, and public IP addresses from daemon health reports', async () => {
    const db = makeDbNode({ certificateSerial: 'AA:01' });
    const deps = makeDeps(db);
    const stream = makeStream({ serialNumber: 'aa01' });

    createControlHandlers(deps).CommandStream(stream);
    await emitRegister(stream);
    stream.emit('data', {
      healthReport: {
        timestamp: '1',
        diskMounts: [],
        networkInterfaces: [
          {
            name: 'eth0',
            rxBytes: '1',
            txBytes: '2',
            rxPackets: '3',
            txPackets: '4',
            rxErrors: '0',
            txErrors: '0',
            ipAddresses: ['10.0.0.8', '2001:db8::10'],
          },
        ],
        localIpAddresses: ['10.0.0.8', 'fd00::10'],
        publicIpAddresses: ['203.0.113.10', '2001:db8::10'],
      },
    });

    await vi.waitFor(() => {
      expect(deps.registry.updateHealthReport).toHaveBeenCalledWith(
        nodeId,
        expect.objectContaining({
          localIpAddresses: ['10.0.0.8', 'fd00::10'],
          publicIpAddresses: ['203.0.113.10', '2001:db8::10'],
          networkInterfaces: [
            expect.objectContaining({
              name: 'eth0',
              ipAddresses: ['10.0.0.8', '2001:db8::10'],
            }),
          ],
        })
      );
    });
  });

  it('does not register a command stream that ends during async authentication', async () => {
    const delayed = makeDelayedDbNode({ certificateSerial: 'aa01' });
    const deps = makeDeps(delayed.db);
    const stream = makeStream({ serialNumber: 'aa01' });

    createControlHandlers(deps).CommandStream(stream);
    stream.emit('data', {
      register: {
        nodeId,
        hostname: 'node-1',
        nginxVersion: '1.27.0',
        configVersionHash: 'hash-daemon',
        daemonVersion: 'dev',
        nginxUptimeSeconds: '10',
        nginxRunning: true,
        cpuModel: 'cpu',
        cpuCores: 2,
        architecture: 'x64',
        kernelVersion: '6.0',
        daemonType: 'nginx',
        capabilities: [],
      },
    });
    stream.emit('end');
    delayed.resolveRows();

    await new Promise((resolve) => setImmediate(resolve));

    expect(deps.registry.register).not.toHaveBeenCalled();
  });

  it('ignores follow-up messages while registration serial validation is pending', async () => {
    const delayed = makeDelayedDbNode({ certificateSerial: 'bb01' });
    const deps = makeDeps(delayed.db);
    const stream = makeStream({ serialNumber: 'aa01' });

    createControlHandlers(deps).CommandStream(stream);
    stream.emit('data', {
      register: {
        nodeId,
        hostname: 'node-1',
        nginxVersion: '1.27.0',
        configVersionHash: 'hash-daemon',
        daemonVersion: 'dev',
        nginxUptimeSeconds: '10',
        nginxRunning: true,
        cpuModel: 'cpu',
        cpuCores: 2,
        architecture: 'x64',
        kernelVersion: '6.0',
        daemonType: 'nginx',
        capabilities: [],
      },
    });
    stream.emit('data', {
      commandResult: {
        commandId: 'cmd-1',
        success: true,
        error: '',
        detail: '',
      },
    });
    delayed.resolveRows();

    await vi.waitFor(() => {
      expect(stream.end).toHaveBeenCalled();
    });

    expect(deps.registry.handleCommandResult).not.toHaveBeenCalled();
    expect(deps.registry.register).not.toHaveBeenCalled();
  });

  it('does not let an older pending registration replace a newer command stream', async () => {
    const queued = makeQueuedDbNode({ certificateSerial: 'aa01' });
    const deps = makeDeps(queued.db);
    const oldStream = makeStream({ serialNumber: 'aa01' });
    const newStream = makeStream({ serialNumber: 'aa01' });

    createControlHandlers(deps).CommandStream(oldStream);
    createControlHandlers(deps).CommandStream(newStream);
    oldStream.emit('data', {
      register: {
        nodeId,
        hostname: 'old-node',
        nginxVersion: '1.27.0',
        configVersionHash: 'old-hash',
        daemonVersion: 'dev',
        nginxUptimeSeconds: '10',
        nginxRunning: true,
        cpuModel: 'cpu',
        cpuCores: 2,
        architecture: 'x64',
        kernelVersion: '6.0',
        daemonType: 'nginx',
        capabilities: [],
      },
    });
    newStream.emit('data', {
      register: {
        nodeId,
        hostname: 'new-node',
        nginxVersion: '1.27.0',
        configVersionHash: 'new-hash',
        daemonVersion: 'dev',
        nginxUptimeSeconds: '10',
        nginxRunning: true,
        cpuModel: 'cpu',
        cpuCores: 2,
        architecture: 'x64',
        kernelVersion: '6.0',
        daemonType: 'nginx',
        capabilities: [],
      },
    });

    queued.resolveNext();
    queued.resolveNext();

    await vi.waitFor(() => {
      expect(deps.registry.register).toHaveBeenCalledTimes(1);
    });

    expect(deps.registry.register).toHaveBeenCalledWith(
      nodeId,
      'nginx',
      'new-node',
      'new-hash',
      newStream,
      expect.objectContaining({ isCurrentRegistration: expect.any(Function) })
    );
    expect(oldStream.end).toHaveBeenCalled();
  });

  it('deregisters and closes the stream when registration metadata update fails after registry insert', async () => {
    const db = makeDbNodeWithFailingRegistrationMetadataUpdate();
    const deps = makeDeps(db);
    const stream = makeStream({ serialNumber: 'aa01' });

    createControlHandlers(deps).CommandStream(stream);
    stream.emit('data', {
      register: {
        nodeId,
        hostname: 'node-1',
        nginxVersion: '1.27.0',
        configVersionHash: 'hash-daemon',
        daemonVersion: 'dev',
        nginxUptimeSeconds: '10',
        nginxRunning: true,
        cpuModel: 'cpu',
        cpuCores: 2,
        architecture: 'x64',
        kernelVersion: '6.0',
        daemonType: 'nginx',
        capabilities: [],
      },
    });

    await vi.waitFor(() => {
      expect(deps.registry.deregister).toHaveBeenCalledWith(nodeId, stream);
    });
    expect(stream.end).toHaveBeenCalled();
    expect(deps.registry.handleCommandResult).not.toHaveBeenCalled();
  });

  it('ignores messages from a stream that is no longer the registered command stream', async () => {
    const db = makeDbNode({ certificateSerial: 'aa01' });
    const deps = makeDeps(db);
    const stream = makeStream({ serialNumber: 'aa01' });

    createControlHandlers(deps).CommandStream(stream);
    await emitRegister(stream);
    deps.registry.getNode.mockReturnValue({ commandStream: makeStream({ serialNumber: 'aa01' }) });

    stream.emit('data', {
      commandResult: {
        commandId: 'cmd-1',
        success: true,
        error: '',
        detail: '',
      },
    });

    expect(deps.registry.handleCommandResult).not.toHaveBeenCalled();
    expect(stream.end).toHaveBeenCalled();
  });

  it('rejects registration when cert serial does not match DB', async () => {
    const db = makeDbNode({ certificateSerial: 'bb01' });
    const deps = makeDeps(db);
    const stream = makeStream({ serialNumber: 'aa01' });

    createControlHandlers(deps).CommandStream(stream);
    await emitRegister(stream);

    expect(deps.registry.register).not.toHaveBeenCalled();
    expect(stream.end).toHaveBeenCalled();
  });

  it('does not retain claimed node identity after rejected registration', async () => {
    const db = makeDbNode({ certificateSerial: 'bb01' });
    const deps = makeDeps(db);
    const stream = makeStream({ serialNumber: 'aa01' });

    createControlHandlers(deps).CommandStream(stream);
    await emitRegister(stream);
    stream.emit('data', {
      commandResult: {
        commandId: 'cmd-1',
        success: true,
        error: '',
        detail: '',
      },
    });

    expect(deps.registry.register).not.toHaveBeenCalled();
    expect(deps.registry.handleCommandResult).not.toHaveBeenCalled();
  });

  it('rejects registration when node certificate serial is missing', async () => {
    const db = makeDbNode({ certificateSerial: null });
    const deps = makeDeps(db);
    const stream = makeStream({ serialNumber: 'aa01' });

    createControlHandlers(deps).CommandStream(stream);
    await emitRegister(stream);

    expect(deps.registry.register).not.toHaveBeenCalled();
    expect(stream.end).toHaveBeenCalled();
  });

  it('rejects registration when node is pending', async () => {
    const db = makeDbNode({ certificateSerial: 'aa01', status: 'pending' });
    const deps = makeDeps(db);
    const stream = makeStream({ serialNumber: 'aa01' });

    createControlHandlers(deps).CommandStream(stream);
    await emitRegister(stream);

    expect(deps.registry.register).not.toHaveBeenCalled();
    expect(stream.end).toHaveBeenCalled();
  });

  it('rejects registration when mTLS authorization state is ambiguous', async () => {
    const db = makeDbNode({ certificateSerial: 'aa01' });
    const deps = makeDeps(db);
    const stream = makeStream({ serialNumber: 'aa01', includeAuthorized: false });

    createControlHandlers(deps).CommandStream(stream);
    await emitRegister(stream);

    expect(deps.registry.register).not.toHaveBeenCalled();
    expect(stream.end).toHaveBeenCalled();
  });
});
