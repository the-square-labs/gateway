import { Key, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { OneTimeTokenDialog } from "@/components/common/OneTimeTokenDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { ScopeList } from "@/components/common/ScopeList";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  buildFinalScopes,
  deriveAllowedResourceIdsByScope,
  hasSelectableScopeBase,
  parseScopesForForm,
  requiresResourceSelection,
} from "@/lib/scope-utils";
import { formatDate, formatRelativeDate } from "@/lib/utils";
import { api } from "@/services/api";
import { useCAStore } from "@/stores/ca";
import type { DatabaseConnection, LoggingSchema, Node, ProxyHost, User } from "@/types";
import { API_TOKEN_SCOPES, type ApiToken, RESOURCE_SCOPABLE_SCOPES } from "@/types";

interface ApiTokensSectionProps {
  user: User | null;
  nodesList: Node[];
  proxyHostsList: ProxyHost[];
  databasesList: DatabaseConnection[];
  loggingSchemasList: LoggingSchema[];
}

export function ApiTokensSection({
  user,
  nodesList,
  proxyHostsList,
  databasesList,
  loggingSchemasList,
}: ApiTokensSectionProps) {
  const { cas } = useCAStore();
  const cachedTokens = api.getCached<ApiToken[]>("settings:api-tokens");
  const [tokens, setTokens] = useState<ApiToken[]>(() => cachedTokens ?? []);
  const [loading, setLoading] = useState(() => cachedTokens === undefined);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [resourceScopes, setResourceScopes] = useState<Record<string, string[]>>({});
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [createdSecretDialogOpen, setCreatedSecretDialogOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [tokenScopeSearch, setTokenScopeSearch] = useState("");
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
  const tokenChanged = useMemo(() => {
    if (!editingToken) return false;
    return newTokenName.trim() !== editingToken.name || tokenScopesChanged;
  }, [editingToken, newTokenName, tokenScopesChanged]);

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

  const openTokenEdit = (token: ApiToken) => {
    setEditingToken(token);
    setNewTokenName(token.name);
    const parsed = parseScopesForForm(token.scopes || []);
    setSelectedScopes(parsed.baseScopes);
    setResourceScopes(parsed.resources);
    setInitialResourceLimitedScopes(Object.keys(parsed.resources));
    setCreatedSecret(null);
    setTokenScopeSearch("");
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
    if (finalTokenScopes.length === 0) {
      toast.error("Select at least one scope");
      return false;
    }
    return true;
  };

  const handleTokenUpdate = async () => {
    if (!editingToken || !newTokenName.trim()) return;
    if (!validateScopeSelection()) return;
    try {
      await api.updateToken(editingToken.id, {
        ...(newTokenName.trim() !== editingToken.name ? { name: newTokenName.trim() } : {}),
        ...(tokenScopesChanged ? { scopes: finalTokenScopes } : {}),
      });
      toast.success("Token updated");
      setCreateDialogOpen(false);
      loadTokens();
      setTimeout(() => setEditingToken(null), 200);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update token");
    }
  };

  const openTokenCreate = () => {
    setEditingToken(null);
    setNewTokenName("");
    setSelectedScopes([]);
    setResourceScopes({});
    setInitialResourceLimitedScopes([]);
    setCreatedSecret(null);
    setTokenScopeSearch("");
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
      const result = await api.createToken({ name: newTokenName, scopes: finalTokenScopes });
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
    try {
      await api.revokeToken(token.id);
      toast.success("Token revoked");
      loadTokens();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke token");
    }
  };

  return (
    <>
      <PanelShell
        title="API Tokens"
        description="Granular tokens for programmatic access. AI is available to users only."
        actions={
          <Button onClick={openTokenCreate}>
            <Plus className="h-4 w-4" />
            Create Token
          </Button>
        }
      >
        <div>
          {loading ? (
            <TokenRowsSkeleton />
          ) : tokens.length > 0 ? (
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
                        {token.tokenPrefix}... &middot; Created {formatDate(token.createdAt)}
                        {token.lastUsedAt
                          ? ` · Last used ${formatRelativeDate(token.lastUsedAt)}`
                          : " · Never used"}
                        {` · Scopes: ${(token.scopes || []).length}`}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
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
          if (!open) {
            setInitialResourceLimitedScopes([]);
            setTimeout(() => setEditingToken(null), 200);
          }
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
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name</label>
              <Input
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="e.g., CI/CD Pipeline"
                autoFocus
              />
            </div>

            <div className="border border-border">
              <Input
                value={tokenScopeSearch}
                onChange={(e) => setTokenScopeSearch(e.target.value)}
                placeholder="Search scopes..."
                className="border-0 border-b border-border rounded-none h-9 text-sm focus-visible:ring-0"
              />
              <ScopeList
                scopes={API_TOKEN_SCOPES.filter(
                  (scope) =>
                    selectedScopes.includes(scope.value) ||
                    hasSelectableScopeBase(userScopes, scope.value)
                )}
                search={tokenScopeSearch}
                selected={selectedScopes}
                onToggle={toggleScope}
                resources={resourceScopes}
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
              />
              <div className="border-t border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  {finalTokenScopes.length} scope{finalTokenScopes.length !== 1 ? "s" : ""}
                </p>
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              {editingToken ? "Close" : "Cancel"}
            </Button>
            {editingToken ? (
              <Button
                onClick={handleTokenUpdate}
                disabled={!newTokenName.trim() || !tokenChanged || finalTokenScopes.length === 0}
              >
                Save
              </Button>
            ) : (
              <Button
                onClick={handleCreateToken}
                disabled={isCreating || finalTokenScopes.length === 0}
              >
                {isCreating ? "Creating..." : "Create Token"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OneTimeTokenDialog
        open={createdSecretDialogOpen}
        onOpenChange={setCreatedSecretDialogOpen}
        title="API Token Created"
        token={createdSecret}
        tokenLabel="API token"
        onClosed={() => setCreatedSecret(null)}
      />
    </>
  );
}

function TokenRowsSkeleton() {
  return (
    <div className="divide-y divide-border" aria-label="Loading API tokens">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-3 p-4 sm:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Skeleton className="h-10 w-10 shrink-0" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-64 max-w-[60vw]" />
            </div>
          </div>
          <Skeleton className="h-9 w-9 shrink-0" />
        </div>
      ))}
    </div>
  );
}
