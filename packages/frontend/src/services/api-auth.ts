import type { AIApprovalMode } from "@/lib/ai-approval-mode";
import { useAuthStore } from "@/stores/auth";
import type { BrowserSession, OAuthAuthorization, OAuthConsentPreview, User } from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

const AUTH_BASE = "/auth";
export type PreferredInterface = "ai_workspace" | "operations_console";
export interface UserPreferences {
  aiApprovalMode: AIApprovalMode;
  preferredInterface: PreferredInterface | null;
  preferredInterfaceSelectedAt: string | null;
}

export function withAuthApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class AuthApiClient extends Base {
    // ── Auth ──────────────────────────────────────────────────────────

    async getCurrentUser(): Promise<User> {
      return this.request<User>("/auth/me");
    }

    async getUserPreferences(): Promise<UserPreferences> {
      return this.cachedRequest("auth:me:preferences", () =>
        this.request<UserPreferences>("/auth/me/preferences")
      );
    }

    async updateUserPreferences(input: {
      aiApprovalMode?: AIApprovalMode;
      preferredInterface?: PreferredInterface;
    }): Promise<UserPreferences> {
      const preferences = await this.request<UserPreferences>("/auth/me/preferences", {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      this.setCache("auth:me:preferences", preferences);
      return preferences;
    }

    async listCurrentUserSessions(): Promise<BrowserSession[]> {
      return this.request<BrowserSession[]>("/auth/me/sessions");
    }

    async revokeCurrentUserSession(id: string): Promise<void> {
      await this.request(`/auth/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    }

    async revokeOtherCurrentUserSessions(): Promise<number> {
      const response = await this.request<{ revoked: number }>("/auth/me/sessions/revoke-others", {
        method: "POST",
      });
      return response.revoked;
    }

    async getCurrentUserMfaStatus(): Promise<{
      totpConfigured: boolean;
      passkeyCount: number;
      recoveryCodeCount: number;
      required: boolean;
    }> {
      return this.request("/auth/me/mfa");
    }

    async beginCurrentUserTotpSetup(): Promise<{ secret: string; uri: string }> {
      return this.request("/auth/me/mfa/totp/setup", { method: "POST" });
    }

    async resetCurrentUserTotp(): Promise<void> {
      await this.request("/auth/me/mfa/totp/reset", { method: "POST" });
    }

    async confirmCurrentUserTotpSetup(code: string): Promise<string[]> {
      const response = await this.request<{ recoveryCodes: string[] }>(
        "/auth/me/mfa/totp/confirm",
        { method: "POST", body: JSON.stringify({ code }) }
      );
      return response.recoveryCodes;
    }

    async regenerateCurrentUserRecoveryCodes(code: string): Promise<string[]> {
      const response = await this.request<{ recoveryCodes: string[] }>(
        "/auth/me/mfa/recovery-codes",
        { method: "POST", body: JSON.stringify({ code }) }
      );
      return response.recoveryCodes;
    }

    async listCurrentUserPasskeys(): Promise<
      Array<{ id: string; name: string; lastUsedAt: string | null; createdAt: string }>
    > {
      return this.request("/auth/me/passkeys");
    }

    async beginCurrentUserPasskeyRegistration(): Promise<Record<string, unknown>> {
      return this.request("/auth/me/passkeys/options", { method: "POST" });
    }

    async finishCurrentUserPasskeyRegistration(response: unknown, name?: string): Promise<void> {
      await this.request("/auth/me/passkeys", {
        method: "POST",
        body: JSON.stringify({ response, name }),
      });
    }

    async removeCurrentUserPasskey(id: string): Promise<void> {
      await this.request(`/auth/me/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
    }

    async logout(): Promise<void> {
      try {
        await this.request<void>("/auth/logout", { method: "POST" });
      } finally {
        this.clearCsrfToken();
        useAuthStore.getState().logout();
      }
    }

    getLoginUrl(): string {
      return `${AUTH_BASE}/login`;
    }

    async getOAuthConsent(requestId: string): Promise<OAuthConsentPreview> {
      return this.request<OAuthConsentPreview>(
        `/api/oauth/consent/${encodeURIComponent(requestId)}`
      );
    }

    async approveOAuthConsent(
      requestId: string,
      scopes: string[]
    ): Promise<{ redirectUrl: string }> {
      return this.request<{ redirectUrl: string }>(
        `/api/oauth/consent/${encodeURIComponent(requestId)}/approve`,
        {
          method: "POST",
          body: JSON.stringify({ scopes }),
        }
      );
    }

    async denyOAuthConsent(requestId: string): Promise<{ redirectUrl: string }> {
      return this.request<{ redirectUrl: string }>(
        `/api/oauth/consent/${encodeURIComponent(requestId)}/deny`,
        {
          method: "POST",
          body: JSON.stringify({}),
        }
      );
    }

    async listOAuthAuthorizations(): Promise<OAuthAuthorization[]> {
      return this.unwrapData(
        this.request<{ data: OAuthAuthorization[] }>("/api/oauth/authorizations")
      );
    }

    async revokeOAuthAuthorization(clientId: string, resource: string): Promise<void> {
      await this.request<void>(
        `/api/oauth/authorizations/${encodeURIComponent(clientId)}?resource=${encodeURIComponent(resource)}`,
        {
          method: "DELETE",
        }
      );
    }

    async updateOAuthAuthorization(
      clientId: string,
      resource: string,
      scopes: string[]
    ): Promise<OAuthAuthorization> {
      return this.unwrapData(
        this.request<{ data: OAuthAuthorization }>(
          `/api/oauth/authorizations/${encodeURIComponent(clientId)}?resource=${encodeURIComponent(resource)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ scopes }),
          }
        )
      );
    }
  };
}
