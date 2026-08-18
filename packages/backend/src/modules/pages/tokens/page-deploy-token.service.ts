import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { pageDeployTokens, pageProjects } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CreatePageDeployTokenInput } from './page-deploy-token.schemas.js';

export function hashPageDeployToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface ValidatedPageDeployToken {
  tokenId: string;
  tokenPrefix: string;
  projectId: string;
  allowedTagPatterns: string[];
  allowUserTag: boolean;
}

export function assertPageDeployTokenTagAllowed(token: ValidatedPageDeployToken, tag: string | null | undefined): void {
  if (!tag) return;
  if (!token.allowUserTag) {
    throw new AppError(403, 'PAGE_DEPLOY_TOKEN_TAG_FORBIDDEN', 'This deploy token cannot publish Tags');
  }
  if (token.allowedTagPatterns.length === 0) return;

  const allowed = token.allowedTagPatterns.some((pattern) => {
    const expression = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${expression}$`).test(tag);
  });
  if (!allowed) {
    throw new AppError(403, 'PAGE_DEPLOY_TOKEN_TAG_FORBIDDEN', 'The requested Tag is outside this deploy token policy');
  }
}

export class PageDeployTokenService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  async list(projectId: string) {
    await this.ensureProject(projectId);
    const rows = await this.db
      .select()
      .from(pageDeployTokens)
      .where(eq(pageDeployTokens.projectId, projectId))
      .orderBy(desc(pageDeployTokens.createdAt));
    return rows.map((token) => ({
      id: token.id,
      projectId: token.projectId,
      name: token.name,
      tokenPrefix: token.tokenPrefix,
      allowedTagPatterns: token.allowedTagPatterns,
      allowUserTag: token.allowUserTag,
      lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
      expiresAt: token.expiresAt?.toISOString() ?? null,
      revokedAt: token.revokedAt?.toISOString() ?? null,
      createdAt: token.createdAt.toISOString(),
    }));
  }

  async create(projectId: string, input: CreatePageDeployTokenInput, userId: string) {
    await this.ensureProject(projectId);
    const raw = `gwp_${randomBytes(32).toString('hex')}`;
    const [token] = await this.db
      .insert(pageDeployTokens)
      .values({
        projectId,
        name: input.name,
        tokenPrefix: raw.slice(0, 12),
        tokenHash: hashPageDeployToken(raw),
        allowedTagPatterns: input.allowedTagPatterns,
        allowUserTag: input.allowUserTag,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdById: userId,
      })
      .returning();
    if (!token) throw new AppError(500, 'PAGE_DEPLOY_TOKEN_CREATE_FAILED', 'Deploy token was not created');
    await this.auditService.log({
      userId,
      action: 'page_deploy_token.create',
      resourceType: 'page_deploy_token',
      resourceId: token.id,
      details: {
        projectId,
        name: token.name,
        tokenPrefix: token.tokenPrefix,
        allowedTagPatterns: token.allowedTagPatterns,
        allowUserTag: token.allowUserTag,
      },
    });
    return {
      id: token.id,
      projectId,
      name: token.name,
      tokenPrefix: token.tokenPrefix,
      allowedTagPatterns: token.allowedTagPatterns,
      allowUserTag: token.allowUserTag,
      expiresAt: token.expiresAt?.toISOString() ?? null,
      createdAt: token.createdAt.toISOString(),
      token: raw,
    };
  }

  async revoke(projectId: string, tokenId: string, userId: string): Promise<void> {
    const [token] = await this.db
      .select()
      .from(pageDeployTokens)
      .where(and(eq(pageDeployTokens.id, tokenId), eq(pageDeployTokens.projectId, projectId)))
      .limit(1);
    if (!token) throw new AppError(404, 'PAGE_DEPLOY_TOKEN_NOT_FOUND', 'Page deploy token not found');
    if (!token.revokedAt) {
      await this.db
        .update(pageDeployTokens)
        .set({ revokedAt: new Date(), revokedById: userId })
        .where(eq(pageDeployTokens.id, tokenId));
    }
    await this.auditService.log({
      userId,
      action: 'page_deploy_token.revoke',
      resourceType: 'page_deploy_token',
      resourceId: tokenId,
      details: { projectId, name: token.name, tokenPrefix: token.tokenPrefix },
    });
  }

  async validate(raw: string): Promise<ValidatedPageDeployToken | null> {
    if (!/^gwp_[0-9a-f]{64}$/.test(raw)) return null;
    const [token] = await this.db
      .select()
      .from(pageDeployTokens)
      .where(and(eq(pageDeployTokens.tokenHash, hashPageDeployToken(raw)), isNull(pageDeployTokens.revokedAt)))
      .limit(1);
    if (!token || (token.expiresAt && token.expiresAt.getTime() <= Date.now())) return null;
    this.db
      .update(pageDeployTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(pageDeployTokens.id, token.id))
      .execute()
      .catch(() => {});
    return {
      tokenId: token.id,
      tokenPrefix: token.tokenPrefix,
      projectId: token.projectId,
      allowedTagPatterns: token.allowedTagPatterns,
      allowUserTag: token.allowUserTag,
    };
  }

  assertTagAllowed(token: ValidatedPageDeployToken, tag: string | null | undefined): void {
    assertPageDeployTokenTagAllowed(token, tag);
  }

  private async ensureProject(projectId: string): Promise<void> {
    const [project] = await this.db
      .select({ id: pageProjects.id })
      .from(pageProjects)
      .where(eq(pageProjects.id, projectId))
      .limit(1);
    if (!project) throw new AppError(404, 'PAGE_PROJECT_NOT_FOUND', 'Page Project not found');
  }
}
