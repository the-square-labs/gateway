import { compareSemver, parseSemver } from '@/lib/semver.js';
import {
  normalizeGitLabApiUrl,
  type TrustedOpenCodexImageArtifact,
  verifyOpenCodexImageManifest,
} from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import { INFERENCE_CORE_PROTOCOL_MAJOR } from './inference-core.contract.js';

/**
 * Release channel for the managed OpenCodex core. Releases are published by the
 * OpenCodex pipeline into the Gateway distribution namespace: one generic
 * package per tag holding the signed `opencodex-image.update.json`. Discovery
 * lists the package registry; the manifest itself is always signature-verified
 * before any Docker mutation is considered.
 */

export const OPENCODEX_RELEASE_TAG_RE = /^v\d+\.\d+\.\d+-wiolett\.\d+$/;

interface GitLabPackageRow {
  version?: unknown;
}

function encodeProjectPath(projectPath: string): string {
  return encodeURIComponent(projectPath);
}

/** Fetch the newest published OpenCodex core tag, or null when none exist yet. */
export async function fetchLatestOpenCodexTag(gitlabApiUrl: string, projectPath: string): Promise<string | null> {
  const base = normalizeGitLabApiUrl(gitlabApiUrl);
  const url =
    `${base}/api/v4/projects/${encodeProjectPath(projectPath)}` +
    `/packages?package_type=generic&package_name=opencodex&per_page=100&sort=desc&order_by=created_at`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new AppError(502, 'CORE_RELEASE_UNAVAILABLE', `Failed to list core releases: ${response.status}`);
  }
  const rows = (await response.json()) as GitLabPackageRow[];
  const tags = rows
    .map((row) => row.version)
    .filter((version): version is string => typeof version === 'string' && OPENCODEX_RELEASE_TAG_RE.test(version));
  if (tags.length === 0) return null;
  return tags.reduce((newest, tag) => (compareOpenCodexVersions(tag, newest) > 0 ? tag : newest));
}

/** Compare `1.2.3-wiolett.4` style versions: semver first, then the build number. */
export function compareOpenCodexVersions(a: string, b: string): number {
  const parsedA = parseOpenCodexVersion(a);
  const parsedB = parseOpenCodexVersion(b);
  if (!parsedA || !parsedB) return 0;
  const semverOrder = compareSemver(parsedA.base, parsedB.base);
  if (semverOrder !== 0) return semverOrder;
  return parsedA.build - parsedB.build;
}

export function parseOpenCodexVersion(version: string): { base: string; build: number } | null {
  const match = /^v?(\d+\.\d+\.\d+)-wiolett\.(\d+)$/.exec(version);
  if (!match || !parseSemver(match[1])) return null;
  return { base: match[1], build: Number(match[2]) };
}

/**
 * Download and verify the signed manifest for one tag. Throws AppError(502)
 * on transport problems and AppError(502, UNTRUSTED_UPDATE_ARTIFACT) on any
 * trust failure — the caller must treat both as "no Docker mutation happened".
 */
export async function fetchOpenCodexImageManifest(
  gitlabApiUrl: string,
  projectPath: string,
  tag: string,
  expectedImage: string,
  publicKey?: string | Buffer
): Promise<TrustedOpenCodexImageArtifact> {
  if (!OPENCODEX_RELEASE_TAG_RE.test(tag)) {
    throw new AppError(400, 'INVALID_CORE_VERSION', `Core release tag must match vX.Y.Z-wiolett.N, got "${tag}"`);
  }
  const base = normalizeGitLabApiUrl(gitlabApiUrl);
  const url =
    `${base}/api/v4/projects/${encodeProjectPath(projectPath)}` +
    `/packages/generic/opencodex/${encodeURIComponent(tag)}/opencodex-image.update.json`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new AppError(502, 'CORE_RELEASE_UNAVAILABLE', `Failed to fetch core release manifest: ${response.status}`);
  }
  const signedManifest = await response.text();
  try {
    return verifyOpenCodexImageManifest(
      signedManifest,
      {
        image: expectedImage,
        coreProtocolMajor: INFERENCE_CORE_PROTOCOL_MAJOR,
        version: tag.slice(1),
        tag,
      },
      publicKey
    );
  } catch {
    throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', 'Core release artifact is not trusted');
  }
}

/**
 * Gateway compatibility gate from the verified manifest: the installed Gateway
 * must satisfy the release's min/max bounds before an install/update proceeds.
 */
export function checkOpenCodexGatewayCompatibility(
  artifact: TrustedOpenCodexImageArtifact,
  currentGatewayVersion: string
): { compatible: boolean; reason: string | null } {
  // Development builds carry no trustworthy version number; never block them.
  if (currentGatewayVersion === 'dev') return { compatible: true, reason: null };
  const current = parseSemver(currentGatewayVersion);
  if (!current) return { compatible: true, reason: null };
  if (artifact.minGatewayVersion && compareSemver(currentGatewayVersion, artifact.minGatewayVersion) < 0) {
    return {
      compatible: false,
      reason: `Core ${artifact.version} requires Gateway ${artifact.minGatewayVersion} or newer`,
    };
  }
  if (artifact.maxGatewayVersion && compareSemver(currentGatewayVersion, artifact.maxGatewayVersion) > 0) {
    return {
      compatible: false,
      reason: `Core ${artifact.version} supports Gateway up to ${artifact.maxGatewayVersion}`,
    };
  }
  return { compatible: true, reason: null };
}
