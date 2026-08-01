import type { Context } from 'hono';

export interface User {
  id: string;
  oidcSubject: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  groupId: string;
  groupName: string;
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
  accessToken: string;
  refreshToken?: string;
  csrfToken?: string;
  createdAt: number;
  expiresAt: number;
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
