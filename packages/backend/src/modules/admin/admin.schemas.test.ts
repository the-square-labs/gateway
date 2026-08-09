import { describe, expect, it } from 'vitest';
import { UpdateAuthProvisioningSettingsSchema } from './admin.schemas.js';

describe('UpdateAuthProvisioningSettingsSchema', () => {
  it('accepts the MCP server toggle', () => {
    const result = UpdateAuthProvisioningSettingsSchema.safeParse({
      mcpServerEnabled: true,
      mcpExtendedCompatibility: true,
    });

    expect(result.success).toBe(true);
  });

  it('accepts auth provisioning compatibility toggles', () => {
    const result = UpdateAuthProvisioningSettingsSchema.safeParse({
      oidcRequireVerifiedEmail: true,
      oauthExtendedCallbackCompatibility: true,
    });

    expect(result.success).toBe(true);
  });

  it('accepts a bounded existing-session MFA grace period', () => {
    const immediate = UpdateAuthProvisioningSettingsSchema.safeParse({
      mfaExistingSessionGracePeriodDays: 0,
    });
    const maximum = UpdateAuthProvisioningSettingsSchema.safeParse({
      mfaExistingSessionGracePeriodDays: 7,
    });

    expect(immediate.success).toBe(true);
    expect(maximum.success).toBe(true);
  });

  it('rejects an out-of-range or fractional existing-session MFA grace period', () => {
    expect(UpdateAuthProvisioningSettingsSchema.safeParse({ mfaExistingSessionGracePeriodDays: -1 }).success).toBe(
      false
    );
    expect(UpdateAuthProvisioningSettingsSchema.safeParse({ mfaExistingSessionGracePeriodDays: 8 }).success).toBe(
      false
    );
    expect(UpdateAuthProvisioningSettingsSchema.safeParse({ mfaExistingSessionGracePeriodDays: 1.5 }).success).toBe(
      false
    );
  });

  it('accepts general file upload limit settings', () => {
    const result = UpdateAuthProvisioningSettingsSchema.safeParse({
      generalSettings: {
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts general feature visibility settings', () => {
    const result = UpdateAuthProvisioningSettingsSchema.safeParse({
      generalSettings: {
        features: {
          pkiEnabled: false,
          domainsEnabled: true,
          siemEnabled: false,
          inferenceEnabled: true,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts bounded graceful shutdown settings and rejects an excessive total', () => {
    expect(
      UpdateAuthProvisioningSettingsSchema.safeParse({
        generalSettings: {
          shutdown: {
            userRequestDrainSeconds: 30,
            structuredLogDrainSeconds: 5,
            finalizationTimeoutSeconds: 10,
          },
        },
      }).success
    ).toBe(true);
    expect(
      UpdateAuthProvisioningSettingsSchema.safeParse({
        generalSettings: {
          shutdown: {
            userRequestDrainSeconds: 40,
            structuredLogDrainSeconds: 10,
            finalizationTimeoutSeconds: 15,
          },
        },
      }).success
    ).toBe(false);
  });

  it('accepts gateway endpoint settings', () => {
    const result = UpdateAuthProvisioningSettingsSchema.safeParse({
      generalSettings: {
        gatewayPublicIps: ['203.0.113.10', '2001:db8::10'],
        gatewayGrpcPublicTarget: 'gateway.example.com:9443',
        gatewayGrpcLocalIp: '10.0.0.5:9443',
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects hostnames for gateway public IPs and local gRPC IP override', () => {
    const publicIpResult = UpdateAuthProvisioningSettingsSchema.safeParse({
      generalSettings: {
        gatewayPublicIps: ['gateway.example.com'],
      },
    });
    const localIpResult = UpdateAuthProvisioningSettingsSchema.safeParse({
      generalSettings: {
        gatewayGrpcLocalIp: 'local.gateway.example.com',
      },
    });

    expect(publicIpResult.success).toBe(false);
    expect(localIpResult.success).toBe(false);
  });

  it('rejects URL-like public gRPC targets', () => {
    const result = UpdateAuthProvisioningSettingsSchema.safeParse({
      generalSettings: {
        gatewayGrpcPublicTarget: 'https://gateway.example.com:9443/path',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid general file upload limit settings', () => {
    const result = UpdateAuthProvisioningSettingsSchema.safeParse({
      generalSettings: {
        fileUploadMaxBytes: 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid trusted proxy CIDRs', () => {
    const result = UpdateAuthProvisioningSettingsSchema.safeParse({
      networkSecurity: {
        trustedProxyCidrs: ['not-a-cidr'],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid outbound webhook private CIDRs', () => {
    const result = UpdateAuthProvisioningSettingsSchema.safeParse({
      outboundWebhookPolicy: {
        allowPrivateNetworks: true,
        allowedPrivateCidrs: ['not-a-cidr'],
      },
    });

    expect(result.success).toBe(false);
  });
});
