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
          inferenceEnabled: true,
        },
      },
    });

    expect(result.success).toBe(true);
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
