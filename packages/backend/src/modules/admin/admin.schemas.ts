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
  name: z.string().max(255).optional(),
  groupId: z.string().uuid(),
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

export const UpdateAuthProvisioningSettingsSchema = z.object({
  oidcAutoCreateUsers: z.boolean().optional(),
  oidcDefaultGroupId: z.string().uuid().optional(),
  oidcRequireVerifiedEmail: z.boolean().optional(),
  oauthExtendedCallbackCompatibility: z.boolean().optional(),
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
export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateAuthProvisioningSettingsInput = z.infer<typeof UpdateAuthProvisioningSettingsSchema>;
