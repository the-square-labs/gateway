import { randomUUID } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { permissionGroups, settings, users } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import type { AuthSettingsService, LocalAuthMethods, PasswordPolicy } from '@/modules/auth/auth.settings.service.js';
import type { AuthMailService, SmtpConfigInput } from '@/modules/auth/auth-mail.service.js';
import type { LocalAuthService } from '@/modules/auth/local-auth.service.js';
import type { OidcConfigInput, OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import type { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import type { LoggingSettingsInput } from '@/modules/logging/logging-settings.service.js';
import type { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import type { FinalizeSetupService } from '@/modules/onboarding/finalize-setup.service.js';
import {
  type GeneralSettingsService,
  normalizeHostPortTarget,
  normalizeIpPortTarget,
  normalizePublicUrl,
} from '@/modules/settings/general-settings.service.js';
import type { SetupAccessService } from './setup-access.service.js';
import type { SetupTokenPolicyService } from './setup-token-policy.js';

export interface SetupAuthInput {
  methods: Pick<LocalAuthMethods, 'oidc' | 'password' | 'emailOtp'>;
  oidc?: OidcConfigInput;
  smtp?: SmtpConfigInput;
  passwordPolicy?: Partial<PasswordPolicy>;
}

export interface SetupAdminInput {
  name: string;
  email: string;
  authMethod: 'oidc' | 'password' | 'email_otp';
  password?: string;
}

export interface SetupNetworkInput {
  grpcPublicTarget: string;
  grpcLocalIp: string;
}

export interface SetupApplyInput {
  publicUrl: string;
  network: SetupNetworkInput;
  auth: SetupAuthInput;
  administrator?: SetupAdminInput;
  logging: LoggingSettingsInput;
}

const FIRST_ADMIN_CLAIM_KEY = 'setup:first_admin_claim';
const SETUP_WIZARD_PHASE_KEY = 'setup:wizard_phase';
const SETUP_AI_WORKSPACE_OUTCOME_KEY = 'setup:ai_workspace_outcome';
const FIRST_ADMIN_CLAIM_TTL_MS = 10 * 60 * 1000;
const logger = createChildLogger('SetupWizard');

export class SetupWizardService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly policy: SetupTokenPolicyService,
    private readonly access: SetupAccessService,
    private readonly generalSettings: GeneralSettingsService,
    private readonly authSettings: AuthSettingsService,
    private readonly oidcSettings: OidcSettingsService,
    private readonly authMail: AuthMailService,
    private readonly authService: AuthService,
    private readonly localAuth: LocalAuthService,
    private readonly finalizeSetup: FinalizeSetupService,
    private readonly mcpSettings: McpSettingsService,
    private readonly refreshGrpcIdentity?: () => Promise<void>,
    private readonly refreshWebIdentity?: () => Promise<void>
  ) {}

  async configureGeneral(publicUrl: string, network: SetupNetworkInput) {
    const general = await this.generalSettings.updateConfig({
      publicUrl,
      gatewayGrpcPublicTarget: network.grpcPublicTarget,
      gatewayGrpcLocalIp: network.grpcLocalIp || null,
    });
    await Promise.all([this.refreshGrpcIdentity?.(), this.refreshWebIdentity?.()]);
    return general;
  }

  async configureAuth(input: SetupAuthInput) {
    if (!input.methods.oidc && !input.methods.password && !input.methods.emailOtp) {
      throw new Error('At least one authentication method must be enabled');
    }
    if (input.oidc) {
      await this.oidcSettings.saveConfig(input.oidc);
      this.authService.invalidateOidcConfiguration();
    }
    if (input.methods.oidc && !(await this.oidcSettings.getPublicConfig()).configured) {
      throw new Error('OIDC must be configured before enabling OIDC sign-in');
    }

    if (input.smtp) {
      await this.authMail.verifyAndSaveConfig(input.smtp);
    }
    if (input.methods.password || input.methods.emailOtp) {
      const smtp = await this.authMail.getPublicConfig();
      if (!smtp.verifiedAt) throw new Error('SMTP must be configured and verified for email-based sign-in');
    }

    return this.authSettings.updateConfig({
      methods: { ...input.methods, passkeyLogin: false },
      passwordPolicy: input.passwordPolicy,
    });
  }

  async apply(input: SetupApplyInput, loggingRuntime: LoggingRuntimeService) {
    const administratorCreated = await this.validateApply(input);
    const [generalSnapshot, authSnapshot, oidcSnapshot, smtpSnapshot, loggingSnapshot] = await Promise.all([
      this.generalSettings.getConfig(),
      this.authSettings.getConfig(),
      this.oidcSettings.snapshotConfig(),
      this.authMail.snapshotConfig(),
      loggingRuntime.snapshot(),
    ]);
    let createdAdministratorId: string | null = null;

    try {
      await this.configureGeneral(input.publicUrl, input.network);
      await this.configureAuth(input.auth);
      await loggingRuntime.update(input.logging);
      if (!administratorCreated) {
        createdAdministratorId = (await this.createAdministrator(input.administrator!)).id;
      }
      await this.setPhase('ai_workspace');
      return { status: 'ready_for_ai' as const };
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      const rollback = async (task: () => Promise<unknown>) => {
        try {
          await task();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      };
      const administratorIdToRollback = createdAdministratorId;
      if (administratorIdToRollback) {
        await rollback(() => this.rollbackAdministrator(administratorIdToRollback));
      }
      await rollback(() => loggingRuntime.restore(loggingSnapshot));
      await rollback(() => this.authSettings.updateConfig(authSnapshot));
      await rollback(() => this.oidcSettings.restoreConfig(oidcSnapshot));
      await rollback(() => this.authMail.restoreConfig(smtpSnapshot));
      await rollback(async () => {
        await this.generalSettings.updateConfig(generalSnapshot);
        await Promise.all([this.refreshGrpcIdentity?.(), this.refreshWebIdentity?.()]);
      });
      if (rollbackFailures.length > 0) {
        logger.error('Setup apply rollback was incomplete', {
          failures: rollbackFailures.map((rollbackError) =>
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          ),
        });
      }
      this.authService.invalidateOidcConfiguration();
      throw error;
    }
  }

  async createAdministrator(input: SetupAdminInput) {
    if (await this.policy.isGatewayConfigured()) throw new Error('The first administrator has already been created');

    const methods = (await this.authSettings.getConfig()).methods;
    const methodEnabled =
      input.authMethod === 'oidc'
        ? methods.oidc
        : input.authMethod === 'password'
          ? methods.password
          : methods.emailOtp;
    if (!methodEnabled) throw new Error('The selected administrator authentication method is not enabled');
    if (input.authMethod === 'password' && !input.password) throw new Error('Password is required');
    if (input.authMethod === 'password') await this.localAuth.validateInitialPasswordForSetup(input.password!);

    const claim = randomUUID();
    await this.db
      .delete(settings)
      .where(
        and(
          eq(settings.key, FIRST_ADMIN_CLAIM_KEY),
          lt(settings.updatedAt, new Date(Date.now() - FIRST_ADMIN_CLAIM_TTL_MS))
        )
      );
    const [claimed] = await this.db
      .insert(settings)
      .values({ key: FIRST_ADMIN_CLAIM_KEY, value: claim, updatedAt: new Date() })
      .onConflictDoNothing()
      .returning({ key: settings.key });
    if (!claimed) throw new Error('The first administrator is already being created');

    let createdUserId: string | null = null;
    try {
      // Re-check after obtaining the database-backed singleton claim. This
      // closes the race between multiple app processes receiving setup calls.
      if (await this.policy.isGatewayConfigured()) throw new Error('The first administrator has already been created');

      const adminGroup = await this.db.query.permissionGroups.findFirst({
        where: eq(permissionGroups.name, 'system-admin'),
      });
      if (!adminGroup) throw new Error('Built-in system-admin group not found');

      const user = await this.authService.createUser({
        name: input.name,
        email: input.email,
        groupId: adminGroup.id,
        authMethod: input.authMethod,
      });
      createdUserId = user.id;
      if (input.authMethod === 'password') {
        await this.localAuth.setInitialPasswordForSetup(user.id, input.password!);
      }
      await this.finalizeSetup.initializeOwner(user.id);
      return user;
    } catch (error) {
      if (createdUserId)
        await this.db
          .delete(users)
          .where(eq(users.id, createdUserId))
          .catch(() => {});
      if (createdUserId) await this.finalizeSetup.clearOwner(createdUserId).catch(() => {});
      await this.db
        .delete(settings)
        .where(and(eq(settings.key, FIRST_ADMIN_CLAIM_KEY), eq(settings.value, claim)))
        .catch(() => {});
      throw error;
    }
  }

  async getPhase(): Promise<'configuration' | 'ai_workspace'> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETUP_WIZARD_PHASE_KEY))
      .limit(1);
    return row?.value === 'ai_workspace' ? 'ai_workspace' : 'configuration';
  }

  async completeAIWorkspace(outcome: {
    status: 'configured' | 'skipped';
    configuredVia?: 'direct' | 'gateway_inference';
  }): Promise<void> {
    await this.generalSettings.requirePublicUrl();
    if (!(await this.policy.isGatewayConfigured()))
      throw new Error('Create the first administrator before completing setup');
    if ((await this.getPhase()) !== 'ai_workspace')
      throw new Error('Apply Gateway setup before configuring AI Workspace');
    const methods = (await this.authSettings.getConfig()).methods;
    if (!methods.oidc && !methods.password && !methods.emailOtp) {
      throw new Error('Configure at least one authentication method before completing setup');
    }
    await this.db
      .insert(settings)
      .values({ key: SETUP_AI_WORKSPACE_OUTCOME_KEY, value: outcome, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: outcome, updatedAt: new Date() },
      });
    await this.finalizeSetup.applySetupAIWorkspaceOutcomeForOwner(outcome.status);
    await this.mcpSettings.updateConfig({ serverEnabled: true });
    await this.policy.markSetupComplete();
    await Promise.allSettled([
      this.access.invalidate(),
      this.db.delete(settings).where(eq(settings.key, FIRST_ADMIN_CLAIM_KEY)),
    ]);
  }

  private async setPhase(phase: 'configuration' | 'ai_workspace'): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: SETUP_WIZARD_PHASE_KEY, value: phase, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: phase, updatedAt: new Date() },
      });
  }

  private async rollbackAdministrator(userId: string): Promise<void> {
    await this.db.delete(users).where(eq(users.id, userId));
    await this.db.delete(settings).where(eq(settings.key, FIRST_ADMIN_CLAIM_KEY));
    await this.finalizeSetup.clearOwner(userId);
  }

  private async validateApply(input: SetupApplyInput): Promise<boolean> {
    if (!normalizePublicUrl(input.publicUrl)) throw new Error('Gateway public URL is required');
    if (!normalizeHostPortTarget(input.network.grpcPublicTarget)) {
      throw new Error('Gateway gRPC public target is required');
    }
    normalizeIpPortTarget(input.network.grpcLocalIp);
    if (!input.auth.methods.oidc && !input.auth.methods.password && !input.auth.methods.emailOtp) {
      throw new Error('At least one authentication method must be enabled');
    }

    const administratorCreated = await this.policy.isGatewayConfigured();
    if (!administratorCreated) {
      if (!input.administrator) throw new Error('First administrator details are required');
      const methodEnabled =
        input.administrator.authMethod === 'oidc'
          ? input.auth.methods.oidc
          : input.administrator.authMethod === 'password'
            ? input.auth.methods.password
            : input.auth.methods.emailOtp;
      if (!methodEnabled) throw new Error('The selected administrator authentication method is not enabled');
      if (input.administrator.authMethod === 'password') {
        if (!input.administrator.password) throw new Error('Password is required');
        await this.localAuth.validateInitialPasswordForSetup(input.administrator.password);
      }
    }

    if (input.auth.methods.oidc && !input.auth.oidc && !(await this.oidcSettings.getPublicConfig()).configured) {
      throw new Error('OIDC configuration is required');
    }
    if (
      (input.auth.methods.password || input.auth.methods.emailOtp) &&
      !input.auth.smtp &&
      !(await this.authMail.getPublicConfig()).configured
    ) {
      throw new Error('SMTP configuration is required');
    }
    return administratorCreated;
  }
}
