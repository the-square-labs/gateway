/**
 * Internal PKI of the installation: the certificate authorities, the
 * certificates they issued and the PKI certificate templates.
 * The first two CAs are the ones the dashboard and pickers already show.
 * Seeds 23000-23999 belong to this file.
 */
import { HttpResponse, http } from "msw";
import type { CA, Certificate, Template } from "@/types";
import { ok } from "../../handlers";
import { people } from "../catalog";
import { certificateAuthorities } from "../dashboard";
import { ago, ahead, uuid } from "../time";

const PEM_PLACEHOLDER = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBfixtureCERTIFICATEplaceholderNOTaREALcertificateFORdesignONLY",
  "AAAAexampleEXAMPLEexampleEXAMPLEexampleEXAMPLEexampleEXAMPLEexampl",
  "-----END CERTIFICATE-----",
].join("\n");

const [rootCa, servicesCa] = certificateAuthorities;

function ca(seed: number, overrides: Partial<CA> & Pick<CA, "commonName" | "type">): CA {
  return {
    id: uuid(23000 + seed),
    parentId: null,
    status: "active",
    keyAlgorithm: "ecdsa-p256",
    serialNumber: `3C0${seed}9A0E41D7B2`,
    certificatePem: PEM_PLACEHOLDER,
    subjectDn: `CN=${overrides.commonName},O=Northwind`,
    issuerDn: null,
    pathLengthConstraint: 0,
    maxValidityDays: 825,
    notBefore: ago(200, "d"),
    notAfter: ahead(1600, "d"),
    ocspCertPem: null,
    crlNumber: 6,
    lastCrlAt: ago(5, "h"),
    crlDistributionUrl: null,
    ocspResponderUrl: null,
    caIssuersUrl: null,
    createdById: people[1].id,
    createdAt: ago(200, "d"),
    updatedAt: ago(5, "h"),
    revokedAt: null,
    revocationReason: null,
    certCount: 0,
    ...overrides,
  };
}

export const cas: CA[] = [
  { ...rootCa, certificatePem: PEM_PLACEHOLDER, certCount: 0 },
  { ...servicesCa, certificatePem: PEM_PLACEHOLDER, certCount: 6 },
  ca(1, {
    commonName: "Northwind Clients CA",
    type: "intermediate",
    parentId: rootCa.id,
    issuerDn: rootCa.subjectDn,
    keyAlgorithm: "ecdsa-p256",
    maxValidityDays: 397,
    crlDistributionUrl: "https://gateway.example.com/pki/crl/clients.crl",
    ocspResponderUrl: "https://gateway.example.com/pki/ocsp",
    certCount: 3,
  }),
  ca(2, {
    commonName: "Northwind Lab Root (2021)",
    type: "root",
    keyAlgorithm: "rsa-4096",
    pathLengthConstraint: null,
    maxValidityDays: 1825,
    notBefore: ago(1_800, "d"),
    notAfter: ahead(25, "d"),
    createdAt: ago(1_800, "d"),
    updatedAt: ago(90, "d"),
    lastCrlAt: ago(90, "d"),
    certCount: 1,
  }),
];

export const [pkiRootCa, pkiServicesCa, pkiClientsCa, pkiLabCa] = cas;

// ── Templates ────────────────────────────────────────────────────────────

function template(
  seed: number,
  overrides: Partial<Template> & Pick<Template, "name" | "certType">
): Template {
  return {
    id: uuid(23100 + seed),
    description: null,
    isBuiltin: false,
    keyAlgorithm: "ecdsa-p256",
    validityDays: 90,
    keyUsage: ["digitalSignature", "keyEncipherment"],
    extKeyUsage: ["serverAuth"],
    requireSans: true,
    sanTypes: ["dns"],
    subjectDnFields: { o: "Northwind" },
    crlDistributionPoints: [],
    authorityInfoAccess: {},
    certificatePolicies: [],
    customExtensions: [],
    createdById: people[0].id,
    createdAt: ago(240, "d"),
    updatedAt: ago(240, "d"),
    ...overrides,
  };
}

export const pkiTemplates: Template[] = [
  template(1, {
    name: "TLS Server",
    description: "Standard TLS server certificate for HTTPS services",
    isBuiltin: true,
    certType: "tls-server",
    validityDays: 365,
    sanTypes: ["dns", "ip"],
    createdById: null,
  }),
  template(2, {
    name: "TLS Client",
    description: "Client certificate for mutual TLS authentication",
    isBuiltin: true,
    certType: "tls-client",
    validityDays: 365,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    requireSans: false,
    sanTypes: ["email"],
    createdById: null,
  }),
  template(3, {
    name: "Code Signing",
    description: "Signs release artifacts and container images",
    isBuiltin: true,
    certType: "code-signing",
    keyAlgorithm: "rsa-4096",
    validityDays: 730,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["codeSigning"],
    requireSans: false,
    sanTypes: [],
    createdById: null,
  }),
  template(4, {
    name: "Internal service (90 days)",
    description: "Short-lived server certificates for services behind Secure Link",
    certType: "tls-server",
    validityDays: 90,
    sanTypes: ["dns", "ip"],
    subjectDnFields: { o: "Northwind", ou: "Platform" },
    crlDistributionPoints: ["https://gateway.example.com/pki/crl/services.crl"],
    authorityInfoAccess: { ocspUrl: "https://gateway.example.com/pki/ocsp" },
    updatedAt: ago(12, "d"),
  }),
  template(5, {
    name: "Staff mTLS",
    description: "Laptop certificates for the staff VPN and internal tools",
    certType: "tls-client",
    validityDays: 180,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    requireSans: true,
    sanTypes: ["email"],
    subjectDnFields: { o: "Northwind", ou: "Staff", c: "DE" },
    customExtensions: [{ oid: "1.3.6.1.4.1.32473.1.1", critical: false, value: "staff" }],
    updatedAt: ago(30, "d"),
  }),
];

// ── Certificates ─────────────────────────────────────────────────────────

function certificate(
  seed: number,
  overrides: Partial<Certificate> & Pick<Certificate, "commonName" | "caId">
): Certificate {
  const issuer = cas.find((item) => item.id === overrides.caId)!;
  return {
    id: uuid(23200 + seed),
    templateId: pkiTemplates[3].id,
    status: "active",
    type: "tls-server",
    sans: [overrides.commonName],
    serialNumber: `5E0${seed}0C47A91B3F2D`,
    certificatePem: PEM_PLACEHOLDER,
    keyAlgorithm: "ecdsa-p256",
    subjectDn: `CN=${overrides.commonName},OU=Platform,O=Northwind`,
    issuerDn: issuer.subjectDn,
    notBefore: ago(40, "d"),
    notAfter: ahead(50, "d"),
    csrPem: null,
    serverGenerated: true,
    keyUsage: ["digitalSignature", "keyEncipherment"],
    extKeyUsage: ["serverAuth"],
    revokedAt: null,
    revocationReason: null,
    issuedById: people[1].email,
    createdAt: ago(40, "d"),
    updatedAt: ago(40, "d"),
    ...overrides,
  };
}

export const pkiCertificates: Certificate[] = [
  certificate(1, {
    commonName: "auth.example.com",
    caId: pkiServicesCa.id,
    sans: ["auth.example.com", "status.example.com", "10.0.12.31"],
    notBefore: ago(40, "d"),
    notAfter: ahead(325, "d"),
    templateId: pkiTemplates[0].id,
  }),
  certificate(2, {
    commonName: "api.internal.example.com",
    caId: pkiServicesCa.id,
    sans: ["api.internal.example.com", "10.0.12.40"],
    notBefore: ago(75, "d"),
    notAfter: ahead(15, "d"),
  }),
  certificate(3, {
    commonName: "orders-db.internal.example.com",
    caId: pkiServicesCa.id,
    sans: ["orders-db.internal.example.com"],
    notBefore: ago(12, "d"),
    notAfter: ahead(78, "d"),
  }),
  certificate(4, {
    commonName: "grafana.internal.example.com",
    caId: pkiServicesCa.id,
    notBefore: ago(30, "d"),
    notAfter: ahead(60, "d"),
  }),
  certificate(5, {
    commonName: "lena.novak@example.com",
    caId: pkiClientsCa.id,
    type: "tls-client",
    sans: ["lena.novak@example.com"],
    subjectDn: "CN=lena.novak@example.com,OU=Staff,O=Northwind,C=DE",
    templateId: pkiTemplates[4].id,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    serverGenerated: false,
    csrPem:
      "-----BEGIN CERTIFICATE REQUEST-----\n(fixture placeholder)\n-----END CERTIFICATE REQUEST-----",
    notBefore: ago(20, "d"),
    notAfter: ahead(160, "d"),
    issuedById: people[2].email,
  }),
  certificate(6, {
    commonName: "sam.patel@example.com",
    caId: pkiClientsCa.id,
    type: "tls-client",
    sans: ["sam.patel@example.com"],
    subjectDn: "CN=sam.patel@example.com,OU=Staff,O=Northwind,C=DE",
    templateId: pkiTemplates[4].id,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    notBefore: ago(9, "d"),
    notAfter: ahead(171, "d"),
  }),
  certificate(7, {
    commonName: "release-signing",
    caId: pkiLabCa.id,
    type: "code-signing",
    sans: [],
    keyAlgorithm: "rsa-4096",
    subjectDn: "CN=release-signing,O=Northwind",
    templateId: pkiTemplates[2].id,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["codeSigning"],
    notBefore: ago(400, "d"),
    notAfter: ahead(25, "d"),
  }),
  certificate(8, {
    commonName: "legacy-vpn.example.com",
    caId: pkiServicesCa.id,
    status: "revoked",
    revokedAt: ago(18, "d"),
    revocationReason: "superseded",
    notBefore: ago(120, "d"),
    notAfter: ahead(245, "d"),
  }),
];

export const authCertificate = pkiCertificates[0];

const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });

/** CAs, issued certificates and PKI templates. */
export function pkiHandlers() {
  return [
    http.get("*/api/cas", () => ok(cas)),
    http.get("*/api/cas/:id", ({ params }) => {
      const found = cas.find((item) => item.id === params.id);
      return found ? ok(found) : notFound();
    }),
    http.get("*/api/certificates", ({ request }) => {
      const url = new URL(request.url);
      const caId = url.searchParams.get("caId");
      const status = url.searchParams.get("status");
      const type = url.searchParams.get("type");
      const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
      const rows = pkiCertificates.filter(
        (cert) =>
          (!caId || cert.caId === caId) &&
          (!status || status === "all" || cert.status === status) &&
          (!type || type === "all" || cert.type === type)
      );
      return ok({
        data: rows.slice(0, limit),
        pagination: { page: 1, limit, total: rows.length, totalPages: 1 },
      });
    }),
    http.get("*/api/certificates/:id", ({ params }) => {
      const found = pkiCertificates.find((item) => item.id === params.id);
      return found ? ok(found) : notFound();
    }),
    http.get("*/api/templates", () => ok(pkiTemplates)),
  ];
}
