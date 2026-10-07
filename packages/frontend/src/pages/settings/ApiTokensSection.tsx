import { Key, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { OneTimeSecretDialog } from "@/components/common/OneTimeSecretDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { ScopePicker } from "@/components/common/ScopePicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useRealtime } from "@/hooks/use-realtime";
import {
  buildFinalScopes,
  deriveAllowedResourceIdsByScope,
  hasSelectableScopeBase,
  parseScopesForForm,
  requiresResourceSelection,
} from "@/lib/scope-utils";
import { api } from "@/services/api";
import { apiTokenChangedChannel } from "@/services/user-resource-events";
import { useCAStore } from "@/stores/ca";
import type {
  DatabaseConnection,
  LoggingSchema,
  Node,
  ProxyHost,
  TokenRegistryAccess,
  User,
} from "@/types";
import { API_TOKEN_SCOPES, type ApiToken, RESOURCE_SCOPABLE_SCOPES } from "@/types";
import {
  finalRegistryAccess,
  hasTokenRegistryAccess,
  LEGACY_REGISTRY_SCOPES,
  RegistryAccessFields,
  registryAccessSummary,
} from "./RegistryAccessFields";

interface ApiTokensSectionProps {
  user: User | null;
  nodesList: Node[];
  proxyHostsList: ProxyHost[];
  databasesList: DatabaseConnection[];
  loggingSchemasList: LoggingSchema[];
  /** The resource lists above are still loading; the token dialog waits for them. */
  resourceListsLoading?: boolean;
}

/** Reports a load to the enclosing dialog while rendered inside its content. */
function ReportLoading({ loading }: { loading: boolean }) {
  useContentLoading(loading);
  return null;
}

export function ApiTokensSection({
  user,
  nodesList,
  proxyHostsList,
  databasesList,
  loggingSchemasList,
  resourceListsLoading = false,
}: ApiTokensSectionProps) {
  const { cas } = useCAStore();
  const cachedTokens = api.getCached<ApiToken[]>("settings:api-tokens");
  const [tokens, setTokens] = useState<ApiToken[]>(() => cachedTokens ?? []);
  const [loading, setLoading] = useState(() => cachedTokens === undefined);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [resourceScopes, setResourceScopes] = useState<Record<string, string[]>>({});
  const [registryAccess, setRegistryAccess] = useState<TokenRegistryAccess>({});
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [createdSecretDialogOpen, setCreatedSecretDialogOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [editingToken, setEditingToken] = useState<ApiToken | null>(null);
  const [initialResourceLimitedScopes, setInitialResourceLimitedScopes] = useState<string[]>([]);
  const userScopes = useMemo(() => user?.scopes ?? [], [user?.scopes]);
  const allowedResourceIdsByScope = useMemo(
    () => deriveAllowedResourceIdsByScope(userScopes),
    [userScopes]
  );
  const finalTokenScopes = useMemo(
    () => buildFinalScopes(selectedScopes, resourceScopes),
    [resourceScopes, selectedScopes]
  );
  const initialTokenScopes = useMemo(() => {
    if (!editingToken) return [];
    const parsedInitialScopes = parseScopesForForm(editingToken.scopes);
    return buildFinalScopes(parsedInitialScopes.baseScopes, parsedInitialScopes.resources);
  }, [editingToken]);
  const tokenScopesChanged = useMemo(() => {
    if (!editingToken) return false;
    return initialTokenScopes.join("\n") !== finalTokenScopes.join("\n");
  }, [editingToken, finalTokenScopes, initialTokenScopes]);
  const registryAccessChanged = useMemo(
    () =>
      !!editingToken &&
      JSON.stringify(editingToken.registryAccess ?? {}) !== JSON.stringify(registryAccess),
    [editingToken, registryAccess]
  );
  const tokenChanged = useMemo(() => {
    if (!editingToken) return false;
    return newTokenName.trim() !== editingToken.name || tokenScopesChanged || registryAccessChanged;
  }, [editingToken, newTokenName, tokenScopesChanged, registryAccessChanged]);
  // A registry-only token (CI pushing images) needs no scopes.
  const tokenHasGrants = finalTokenScopes.length > 0 || hasTokenRegistryAccess(registryAccess);

  const loadTokens = useCallback(async () => {
    try {
      const data = await api.listTokens();
      api.setCache("settings:api-tokens", data ?? []);
      setTokens(data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);
  useRealtime(user?.id ? apiTokenChangedChannel(user.id) : null, () => void loadTokens(), {
    onReconnect: loadTokens,
  });

  const openTokenEdit = (token: ApiToken) => {
    setEditingToken(token);
    setNewTokenName(token.name);
    const parsed = parseScopesForForm(token.scopes || []);
    setSelectedScopes(parsed.baseScopes);
    setResourceScopes(parsed.resources);
    setRegistryAccess(token.registryAccess ?? {});
    setInitialResourceLimitedScopes(Object.keys(parsed.resources));
    setCreatedSecret(null);
    setCreateDialogOpen(true);
  };

  const validateScopeSelection = () => {
    for (const scope of selectedScopes) {
      if (
        requiresResourceSelection(scope, allowedResourceIdsByScope, initialResourceLimitedScopes) &&
        (resourceScopes[scope]?.length ?? 0) === 0
      ) {
        toast.error(`Select at least one resource for ${scope}`);
        return false;
      }
    }
    if (!tokenHasGrants) {
      toast.error("Select at least one scope or registry access");
      return false;
    }
    const registry = finalRegistryAccess(registryAccess);
    if (registry.error) {
      toast.error(registry.error);
      return false;
    }
    return true;
  };

  const handleTokenUpdate = async () => {
    if (!editingToken || !newTokenName.trim()) return;
    if (!validateScopeSelection()) return;
    setIsUpdating(true);
    try {
      await api.updateToken(editingToken.id, {
        ...(newTokenName.trim() !== editingToken.name ? { name: newTokenName.trim() } : {}),
        ...(tokenScopesChanged ? { scopes: finalTokenScopes } : {}),
        ...(registryAccessChanged
          ? { registryAccess: finalRegistryAccess(registryAccess).access }
          : {}),
      });
      toast.success("Token updated");
      setCreateDialogOpen(false);
      loadTokens();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update token");
    } finally {
      setIsUpdating(false);
    }
  };

  const openTokenCreate = () => {
    setEditingToken(null);
    setNewTokenName("");
    setSelectedScopes([]);
    setResourceScopes({});
    setRegistryAccess({});
    setInitialResourceLimitedScopes([]);
    setCreatedSecret(null);
    setCreateDialogOpen(true);
  };

  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) => {
      if (prev.includes(scope)) {
        setResourceScopes((resources) => {
          const next = { ...resources };
          delete next[scope];
          return next;
        });
        return prev.filter((s) => s !== scope);
      }
      const allowedResourceIds = allowedResourceIdsByScope[scope];
      if (allowedResourceIds?.length) {
        setResourceScopes((resources) => ({ ...resources, [scope]: allowedResourceIds }));
      }
      return [...prev, scope];
    });
  };

  const handleCreateToken = async () => {
    if (!newTokenName.trim()) {
      toast.error("Token name is required");
      return;
    }
    if (!validateScopeSelection()) return;
    setIsCreating(true);
    try {
      const result = await api.createToken({
        name: newTokenName,
        scopes: finalTokenScopes,
        registryAccess: finalRegistryAccess(registryAccess).access,
      });
      setCreatedSecret(result.token);
      setCreateDialogOpen(false);
      setCreatedSecretDialogOpen(true);
      loadTokens();
      toast.success("API token created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setIsCreating(false);
    }
  };

  const handleRevokeToken = async (token: ApiToken) => {
    const ok = await confirm({
      title: "Revoke Token",
      description: `Are you sure you want to revoke "${token.name}"? This action cannot be undone.`,
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    setRevokingId(token.id);
    try {
      await api.revokeToken(token.id);
      toast.success("Token revoked");
      loadTokens();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke token");
    } finally {
      setRevokingId(null);
    }
  };

  useContentLoading(loading);

  return (
    <>
      <PanelShell
        title="API Tokens"
        description="Granular tokens for programmatic access. AI Workspace, the AI sandbox, and impersonation stay user-only."
        icon={<Key className="h-4 w-4" />}
        actions={
          <Button onClick={openTokenCreate}>
            <Plus className="h-4 w-4" />
            Create Token
          </Button>
        }
      >
        <div>
          {loading ? null : tokens.length > 0 ? (
            <div className="divide-y divide-border">
              {tokens.map((token) => (
                <div
                  key={token.id}
                  className="flex cursor-pointer items-center justify-between gap-3 p-4 transition-colors hover:bg-accent/50 sm:gap-4"
                  onClick={() => openTokenEdit(token)}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-border bg-muted">
                      <Key className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{token.name}</p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {token.tokenPrefix}... &middot; Created{" "}
                        <RelativeTime value={token.createdAt} />
                        {token.lastUsedAt ? (
                          <>
                            {" · Last used "}
                            <RelativeTime value={token.lastUsedAt} />
                          </>
                        ) : (
                          " · Never used"
                        )}
                        {` · Scopes: ${(token.scopes || []).length}`}
                        {registryAccessSummary(token.registryAccess)
                          ? ` · ${registryAccessSummary(token.registryAccess)}`
                          : ""}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={`Revoke ${token.name}`}
                    pending={revokingId === token.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRevokeToken(token);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              message="No API tokens created yet."
              actionLabel="Create one"
              onAction={openTokenCreate}
              embedded
            />
          )}
        </div>
      </PanelShell>

      {/* Create/View Token Dialog */}
      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingToken ? "API Token" : "Create API Token"}</DialogTitle>
            <DialogDescription>
              {editingToken
                ? "Rename this token or edit its granted scopes"
                : "Select granular permissions for this token"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <ReportLoading loading={resourceListsLoading} />
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name</label>
              <Input
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="e.g., CI/CD Pipeline"
                autoFocus
              />
            </div>

            <ScopePicker
              header={<span className="text-sm font-medium">Scopes</span>}
              scopes={API_TOKEN_SCOPES.filter(
                (scope) =>
                  !LEGACY_REGISTRY_SCOPES.has(scope.value) &&
                  (selectedScopes.includes(scope.value) ||
                    hasSelectableScopeBase(userScopes, scope.value))
              )}
              selected={selectedScopes}
              onToggle={toggleScope}
              resources={resourceScopes}
              onResourcesChange={setResourceScopes}
              onToggleResource={(scope, caId) => {
                setResourceScopes((prev) => {
                  const current = prev[scope] || [];
                  const has = current.includes(caId);
                  return {
                    ...prev,
                    [scope]: has ? current.filter((id) => id !== caId) : [...current, caId],
                  };
                });
              }}
              cas={cas}
              nodes={nodesList}
              proxyHosts={proxyHostsList}
              databases={databasesList}
              loggingSchemas={loggingSchemasList}
              restrictableScopes={RESOURCE_SCOPABLE_SCOPES}
              allowedResourceIds={allowedResourceIdsByScope}
              viewportClassName="max-h-[min(20rem,40dvh)] overflow-y-auto overscroll-contain"
              footer={`${finalTokenScopes.length} scope${finalTokenScopes.length !== 1 ? "s" : ""}`}
            />
            <RegistryAccessFields
              value={registryAccess}
              onChange={setRegistryAccess}
              userScopes={userScopes}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              {editingToken ? "Close" : "Cancel"}
            </Button>
            {editingToken ? (
              <Button
                onClick={handleTokenUpdate}
                pending={isUpdating}
                disabled={!newTokenName.trim() || !tokenChanged || !tokenHasGrants}
              >
                Save
              </Button>
            ) : (
              <Button
                onClick={handleCreateToken}
                pending={isCreating}
                disabled={!tokenHasGrants}
              >
                Create Token
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OneTimeSecretDialog
        open={createdSecretDialogOpen}
        onOpenChange={setCreatedSecretDialogOpen}
        title="API Token Created"
        fields={createdSecret ? [{ label: "API token", value: createdSecret }] : null}
        onClosed={() => setCreatedSecret(null)}
      />
    </>
  );
}
