import { z } from 'zod';
import { isValidCidr } from '@/lib/ip-cidr.js';
import {
  FILE_OPEN_MAX_BYTES,
  FILE_OPEN_MIN_BYTES,
  FILE_UPLOAD_MAX_BYTES,
  FILE_UPLOAD_MIN_BYTES,
  isValidGatewayHostPortTarget,
  isValidGatewayIp,
  isValidGatewayIpPortTarget,
} from '@/modules/settings/general-settings.service.js';
import { CLIENT_IP_SOURCE_VALUES } from '@/modules/settings/network-settings.service.js';

export const CreateUserSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().trim().min(1, 'Name is required').max(255),
  groupId: z.string().uuid(),
  authMethod: z.enum(['oidc', 'password', 'email_otp']).default('oidc'),
});

export const UpdateUserGroupSchema = z.object({
  groupId: z.string().uuid(),
});

export const UpdateUserAdditionalPermissionsSchema = z.object({
  additionalScopes: z.array(z.string().trim().min(1).max(512)).max(512),
});

export const UpdateBlockSchema = z.object({
  blocked: z.boolean(),
});

export const RestoreUserSchema = z.object({
  groupId: z.string().uuid().optional(),
});

export const UpdateUserAuthMethodSchema = z.object({
  authMethod: z.enum(['oidc', 'password', 'email_otp']),
});

export const UpdateUserNameSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
});

const AuthMethodsSchema = z.object({
  oidc: z.boolean().optional(),
  password: z.boolean().optional(),
  emailOtp: z.boolean().optional(),
  passkeyLogin: z.boolean().optional(),
});

const PasswordPolicySchema = z.object({
  minLength: z.number().int().min(8).max(72).optional(),
  maxLength: z.number().int().min(8).max(72).optional(),
  requireUppercase: z.boolean().optional(),
  requireLowercase: z.boolean().optional(),
  requireDigit: z.boolean().optional(),
  requireSymbol: z.boolean().optional(),
});

const SmtpConfigSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  tlsMode: z.enum(['starttls', 'tls']),
  username: z.string().trim().max(255),
  password: z.string().min(1).max(1024).optional(),
  senderName: z.string().trim().max(255),
  senderEmail: z.string().email().max(255),
  testRecipient: z.string().email().max(255).optional(),
  testEmailKind: z.enum(['smtp_configuration', 'password_setup', 'password_reset', 'email_otp']).optional(),
});

const OidcConfigSchema = z.object({
  issuer: z.string().url().max(2048),
  clientId: z.string().trim().min(1).max(1024),
  clientSecret: z.string().min(1).max(4096).optional(),
  redirectUri: z.string().url().max(2048),
  scopes: z.string().trim().min(1).max(1024).optional(),
});

export const UpdateAuthProvisioningSettingsSchema = z.object({
  oidcAutoCreateUsers: z.boolean().optional(),
  oidcDefaultGroupId: z.string().uuid().optional(),
  oidcRequireVerifiedEmail: z.boolean().optional(),
  oauthExtendedCallbackCompatibility: z.boolean().optional(),
  methods: AuthMethodsSchema.optional(),
  passwordPolicy: PasswordPolicySchema.optional(),
  oidc: OidcConfigSchema.optional(),
  smtp: SmtpConfigSchema.optional(),
  mcpServerEnabled: z.boolean().optional(),
  mcpExtendedCompatibility: z.boolean().optional(),
  generalSettings: z
    .object({
      fileUploadMaxBytes: z.number().int().min(FILE_UPLOAD_MIN_BYTES).max(FILE_UPLOAD_MAX_BYTES).optional(),
      fileOpenMaxBytes: z.number().int().min(FILE_OPEN_MIN_BYTES).max(FILE_OPEN_MAX_BYTES).optional(),
      gatewayPublicIps: z
        .array(z.string().trim().min(1).max(64).refine(isValidGatewayIp, 'Must be an IPv4 or IPv6 address'))
        .max(16)
        .optional(),
      gatewayGrpcPublicTarget: z
        .string()
        .trim()
        .max(255)
        .refine(isValidGatewayHostPortTarget, 'Must be a hostname or IP address, optionally with a port')
        .nullable()
        .optional(),
      gatewayGrpcLocalIp: z
        .string()
        .trim()
        .max(255)
        .refine(isValidGatewayIpPortTarget, 'Must be an IPv4 or IPv6 address, optionally with a port')
        .nullable()
        .optional(),
      features: z
        .object({
          pkiEnabled: z.boolean().optional(),
          domainsEnabled: z.boolean().optional(),
          inferenceEnabled: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  networkSecurity: z
    .object({
      clientIpSource: z.enum(CLIENT_IP_SOURCE_VALUES).optional(),
      trustedProxyCidrs: z
        .array(z.string().trim().min(1).max(64).refine(isValidCidr, 'Invalid CIDR range'))
        .max(64)
        .optional(),
      trustCloudflareHeaders: z.boolean().optional(),
    })
    .optional(),
  outboundWebhookPolicy: z
    .object({
      allowPrivateNetworks: z.boolean().optional(),
      allowedPrivateCidrs: z
        .array(z.string().trim().min(1).max(64).refine(isValidCidr, 'Invalid CIDR range'))
        .max(64)
        .optional(),
    })
    .optional(),
});

export type UpdateUserGroupInput = z.infer<typeof UpdateUserGroupSchema>;
export type UpdateUserAdditionalPermissionsInput = z.infer<typeof UpdateUserAdditionalPermissionsSchema>;
export type UpdateBlockInput = z.infer<typeof UpdateBlockSchema>;
export type RestoreUserInput = z.infer<typeof RestoreUserSchema>;
export type UpdateUserAuthMethodInput = z.infer<typeof UpdateUserAuthMethodSchema>;
export type UpdateUserNameInput = z.infer<typeof UpdateUserNameSchema>;
export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateAuthProvisioningSettingsInput = z.infer<typeof UpdateAuthProvisioningSettingsSchema>;
