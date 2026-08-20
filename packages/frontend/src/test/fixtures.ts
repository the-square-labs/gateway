import type { Certificate, Node, User } from "@/types";

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    oidcSubject: "oidc-user-1",
    email: "test@example.com",
    name: "Test User",
    avatarUrl: null,
    groupId: "group-1",
    groupName: "Admins",
    scopes: [],
    isBlocked: false,
    ...overrides,
  };
}

export function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: "node-1",
    type: "nginx",
    hostname: "edge-1",
    displayName: "Edge 1",
    appearanceColor: null,
    serviceAddresses: [],
    serviceAddress: null,
    status: "online",
    serviceCreationLocked: false,
    daemonVersion: "1.0.0",
    osInfo: null,
    configVersionHash: null,
    capabilities: {},
    lastSeenAt: new Date().toISOString(),
    lastHealthReport: null,
    lastStatsReport: null,
    healthHistory: [],
    metadata: {},
    isConnected: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
    slug: overrides.slug ?? "edge-1",
  };
}

export function makeCertificate(overrides: Partial<Certificate> = {}): Certificate {
  return {
    id: "cert-1",
    caId: "ca-1",
    templateId: null,
    status: "active",
    type: "tls-server",
    commonName: "gateway-grpc",
    sans: [],
    serialNumber: "ABC123",
    certificatePem: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
    keyAlgorithm: "rsa-2048",
    subjectDn: "CN=gateway-grpc",
    issuerDn: "CN=Gateway Node CA",
    notBefore: new Date().toISOString(),
    notAfter: new Date(Date.now() + 86_400_000).toISOString(),
    csrPem: null,
    serverGenerated: true,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["serverAuth"],
    revokedAt: null,
    revocationReason: null,
    issuedById: "user-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
