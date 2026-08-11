import type { Context } from 'hono';

export type AuthMethod = 'oidc' | 'password' | 'email_otp';

export interface User {
  id: string;
  oidcSubject: string | null;
  authMethod?: AuthMethod;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  groupId: string;
  groupName: string;
  requireGateway2fa?: boolean;
  groupScopes?: string[];
  additionalScopes?: string[];
  scopes: string[];
  isBlocked: boolean;
  isDeleted?: boolean;
  aiApprovalMode?: 'always-ask' | 'normal' | 'bypass-non-destructive' | 'bypass-everything';
  folderId?: string | null;
  sortOrder?: number;
}

export interface SessionData {
  userId: string;
  user: User;
  publicId?: string;
  authMethod?: AuthMethod;
  accessToken?: string;
  refreshToken?: string;
  csrfToken?: string;
  purpose?: 'user' | 'setup';
  setupSessionId?: string;
  createdAt: number;
  lastSeenAt?: number;
  ipAddress?: string;
  userAgent?: string;
  mfaSatisfiedAt?: number;
  mfaGraceExpiresAt?: number;
  expiresAt: number;
}

export interface PublicSession {
  id: string;
  authMethod: AuthMethod;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ipAddress: string | null;
  userAgent: string | null;
  mfaSatisfiedAt: number | null;
  isCurrent: boolean;
}

export interface AppEnv {
  Variables: {
    user?: User;
    sessionId?: string;
    effectiveScopes?: string[];
    isTokenAuth?: boolean;
    authType?: 'session' | 'api-token' | 'oauth-token' | 'inference-token';
    inferenceAuth?: {
      tokenId: string;
      tokenPrefix: string;
      rawToken: string;
    };
    inferenceAdapter?: 'anthropic' | 'codex' | 'openai';
    mcpAuth?: {
      tokenId: string;
      tokenPrefix: string;
      authType?: 'oauth' | 'api-token';
      clientId?: string;
    };
    mcpExtendedCompatibility?: boolean;
    requestId: string;
    loggingIngest?: {
      tokenId: string;
      environmentId: string;
      tokenPrefix: string;
      environment: {
        id: string;
        enabled: boolean;
        schemaMode: 'loose' | 'strip' | 'reject';
        retentionDays: number;
        fieldSchema: import('@/db/schema/index.js').LoggingFieldDefinition[];
        rateLimitRequestsPerWindow: number | null;
        rateLimitEventsPerWindow: number | null;
      };
    };
  };
}

export type AuthenticatedContext = Context<AppEnv> & {
  var: {
    user: User;
    sessionId?: string;
    effectiveScopes?: string[];
    isTokenAuth?: boolean;
    authType?: 'session' | 'api-token' | 'oauth-token' | 'inference-token';
    inferenceAuth?: {
      tokenId: string;
      tokenPrefix: string;
      rawToken: string;
    };
    requestId: string;
  };
};

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
