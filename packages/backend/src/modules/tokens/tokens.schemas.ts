import { z } from 'zod';
import { API_TOKEN_SCOPES, isApiTokenScope } from '@/lib/scopes.js';
import { DelegatedScopeArraySchema, everyReplacementScope } from '@/lib/scopes-schemas.js';

export const AVAILABLE_SCOPES = API_TOKEN_SCOPES;

/** Folder, node, and Docker child restrictions are accepted like on the consent screen. */
const TokenScopeArraySchema = DelegatedScopeArraySchema.min(1, 'At least one scope is required').refine(
  (scopes) => scopes.every((scope) => everyReplacementScope(scope, isApiTokenScope)),
  'One or more scopes cannot be granted to API tokens'
);

export const CreateTokenSchema = z.object({
  name: z.string().trim().min(1).max(255),
  scopes: TokenScopeArraySchema,
});

export const UpdateTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    scopes: TokenScopeArraySchema.optional(),
  })
  .refine((input) => input.name !== undefined || input.scopes !== undefined, 'At least one field is required');

export const TokenResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenPrefix: z.string(),
  scopes: z.array(z.string()),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const CreateTokenResponseSchema = TokenResponseSchema.extend({
  token: z.string(),
});

export type CreateTokenInput = z.infer<typeof CreateTokenSchema>;
export type UpdateTokenInput = z.infer<typeof UpdateTokenSchema>;
export type TokenResponse = z.infer<typeof TokenResponseSchema>;
export type CreateTokenResponse = z.infer<typeof CreateTokenResponseSchema>;
