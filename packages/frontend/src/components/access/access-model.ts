import type { FolderFamily, FolderOption } from "@/components/common/scope-list-helpers";
import { canonicalizeScopeSelection, extractBaseScope, scopeMatches } from "@/lib/scope-utils";
import { TOKEN_SCOPES } from "@/types";
import type { GitScopeProvider } from "@/types/integrations";
import { IMPLIED_SCOPES_BY_REQUIRED_SCOPE } from "@/types/scope-implications";
import { FOLDER_CREATION_SCOPES } from "@/types/scope-resource-restrictions";

/**
 * Access lines: a readable view over ordinary scopes. A line is a role in a place ("Developer in
 * folder orders"), a Git level on repositories ("Use group square-labs/orders"), or the scopes no
 * line covers ("Custom scopes"). Nothing new is stored: lines build plain scopes with folder,
 * resource and Git qualifiers, and stored scopes parse back into lines.
 */

export type AccessRole = "viewer" | "deployer" | "developer" | "operator";

export const ACCESS_ROLES: readonly { id: AccessRole; title: string; summary: string }[] = [
  { id: "viewer", title: "Viewer", summary: "Sees resources, logs and metrics. Changes nothing." },
  {
    id: "deployer",
    title: "Deployer",
    summary: "Ships new versions and restarts workloads. Fits CI tokens.",
  },
  {
    id: "developer",
    title: "Developer",
    summary: "Creates and configures workloads, routes and links.",
  },
  {
    id: "operator",
    title: "Operator",
    summary: "Everything a developer does, plus secrets, console and data writes.",
  },
];

const ROLE_IDS = ACCESS_ROLES.map((role) => role.id);
/** Roles that may also delete resources. */
const DELETING_ROLES = new Set<AccessRole>(["developer", "operator"]);

export function roleTitle(role: AccessRole) {
  return ACCESS_ROLES.find((item) => item.id === role)?.title ?? role;
}

export function roleCanDelete(role: AccessRole) {
  return DELETING_ROLES.has(role);
}

export type AccessTypeId =
  | "containers"
  | "compose"
  | "routes"
  | "domains"
  | "ssl"
  | "databases"
  | "storage"
  | "pages";

export interface AccessType {
  id: AccessTypeId;
  title: string;
  /** The title inside a sentence ("Containers and deployments, databases"). */
  inline: string;
  /** The folder tree of this type. */
  family: FolderFamily;
  /** The scopes each role holds on this type. Operator and Viewer match the built-in groups. */
  roles: Readonly<Record<AccessRole, readonly string[]>>;
  /** Added by "May delete resources" (Developer and Operator only). */
  delete: readonly string[];
  /**
   * Folder management scope that a folder line may add ("Manage subfolders"): create, rename,
   * move and delete folders inside that folder. Absent where folder management is global only.
   */
  foldersManage?: string;
}

export const ACCESS_TYPES: readonly AccessType[] = [
  {
    id: "containers",
    title: "Containers and deployments",
    inline: "containers and deployments",
    family: "docker",
    roles: {
      viewer: ["docker:containers:view"],
      deployer: ["docker:containers:view", "docker:containers:manage"],
      developer: [
        "docker:containers:view",
        "docker:containers:manage",
        "docker:containers:create",
        "docker:containers:edit",
        "docker:containers:environment",
        "docker:containers:link",
      ],
      operator: [
        "docker:containers:view",
        "docker:containers:manage",
        "docker:containers:create",
        "docker:containers:edit",
        "docker:containers:environment",
        "docker:containers:link",
        "docker:containers:secrets",
        "docker:containers:console",
        "docker:containers:webhooks",
      ],
    },
    delete: ["docker:containers:delete"],
  },
  {
    id: "compose",
    title: "Compose projects",
    inline: "Compose projects",
    family: "docker-compose",
    roles: {
      viewer: ["docker:compose:view"],
      deployer: ["docker:compose:view", "docker:compose:manage"],
      developer: ["docker:compose:view", "docker:compose:manage", "docker:compose:create"],
      operator: ["docker:compose:view", "docker:compose:manage", "docker:compose:create"],
    },
    delete: ["docker:compose:delete"],
  },
  {
    id: "routes",
    title: "Routes",
    inline: "routes",
    family: "proxy",
    roles: {
      viewer: ["proxy:view"],
      deployer: ["proxy:view"],
      developer: ["proxy:view", "proxy:create", "proxy:edit"],
      operator: ["proxy:view", "proxy:create", "proxy:edit", "proxy:maintenance:bypass"],
    },
    delete: ["proxy:delete"],
    foldersManage: "proxy:folders:manage",
  },
  {
    id: "domains",
    title: "Domains",
    inline: "domains",
    family: "domains",
    roles: {
      viewer: ["domains:view"],
      deployer: ["domains:view"],
      developer: ["domains:view"],
      operator: ["domains:view", "domains:create", "domains:edit"],
    },
    delete: ["domains:delete"],
    foldersManage: "domains:folders:manage",
  },
  {
    id: "ssl",
    title: "SSL certificates",
    inline: "SSL certificates",
    family: "ssl",
    roles: {
      viewer: ["ssl:cert:view"],
      deployer: ["ssl:cert:view"],
      developer: ["ssl:cert:view", "ssl:cert:issue"],
      operator: ["ssl:cert:view", "ssl:cert:issue", "ssl:cert:renew"],
    },
    delete: ["ssl:cert:delete"],
    foldersManage: "ssl:cert:folders:manage",
  },
  {
    id: "databases",
    title: "Databases",
    inline: "databases",
    family: "databases",
    roles: {
      viewer: ["databases:view"],
      deployer: ["databases:view"],
      // Edit covers linking workloads, so Operator (like the built-in group) holds no bind of its own.
      developer: ["databases:view", "databases:bind", "databases:query:read"],
      operator: [
        "databases:view",
        "databases:create",
        "databases:edit",
        "databases:query:read",
        "databases:query:write",
        "databases:query:admin",
      ],
    },
    delete: ["databases:delete"],
  },
  {
    id: "storage",
    title: "Object storage",
    inline: "object storage",
    family: "storage",
    roles: {
      viewer: ["storage:view"],
      deployer: ["storage:view"],
      developer: ["storage:view", "storage:objects:read"],
      operator: [
        "storage:view",
        "storage:create",
        "storage:edit",
        "storage:credentials:use",
        "storage:objects:read",
        "storage:objects:write",
      ],
    },
    delete: ["storage:delete"],
  },
  {
    id: "pages",
    title: "Pages",
    inline: "Pages",
    family: "pages",
    roles: {
      viewer: ["pages:view"],
      deployer: ["pages:view", "pages:deploy"],
      developer: [
        "pages:view",
        "pages:deploy",
        "pages:create",
        "pages:deployments:manage",
        "pages:tags:manage",
      ],
      operator: [
        "pages:view",
        "pages:deploy",
        "pages:create",
        "pages:deployments:manage",
        "pages:tags:manage",
        "pages:edit",
      ],
    },
    delete: ["pages:delete"],
  },
];

export const ACCESS_TYPE_IDS = ACCESS_TYPES.map((type) => type.id);

export function accessType(id: AccessTypeId): AccessType {
  return ACCESS_TYPES.find((type) => type.id === id)!;
}

const CREATION_SCOPES = new Set<string>(FOLDER_CREATION_SCOPES);

/** Every scope a type's roles and delete name. */
export function accessTypeScopes(type: AccessType): string[] {
  return [...new Set([...ROLE_IDS.flatMap((role) => type.roles[role]), ...type.delete])];
}

/** Types whose folder lines may add "Manage subfolders". */
export function typesManagingFolders(types: readonly AccessTypeId[]): AccessTypeId[] {
  return types.filter((type) => !!accessType(type).foldersManage);
}

const TYPE_BY_SCOPE = new Map<string, AccessType>(
  ACCESS_TYPES.flatMap((type) => accessTypeScopes(type).map((scope) => [scope, type] as const))
);

export type GitLevel = "use" | "read" | "write";

export const GIT_LEVELS: readonly { value: GitLevel; label: string; hint: string }[] = [
  { value: "use", label: "Use", hint: "Connect to workloads and pick a branch. No code." },
  { value: "read", label: "Read code", hint: "Plus read files, pipelines and CI variable names." },
  { value: "write", label: "Edit code and CI", hint: "Plus commit files and change CI settings." },
];

const GIT_LEVEL_ACTIONS: Readonly<Record<GitLevel, readonly string[]>> = {
  use: ["view", "use"],
  read: ["view", "use", "repo:read"],
  write: ["view", "use", "repo:read", "repo:write"],
};

const GIT_PROVIDERS: readonly GitScopeProvider[] = ["gitlab", "github", "git"];

export const GIT_PROVIDER_TITLES: Record<GitScopeProvider, string> = {
  gitlab: "GitLab",
  github: "GitHub",
  git: "Git",
};

/** The container (group or owner) and repository qualifier kinds of a provider. */
export const GIT_TARGET_KINDS: Record<
  GitScopeProvider,
  { container: "group" | "owner"; repository: "project" | "repo" } | null
> = {
  gitlab: { container: "group", repository: "project" },
  github: { container: "owner", repository: "repo" },
  git: null,
};

export function gitLevelScopes(provider: GitScopeProvider, level: GitLevel): string[] {
  return GIT_LEVEL_ACTIONS[level].map((action) => `integrations:${provider}:${action}`);
}

export function gitLevelLabel(level: GitLevel) {
  return GIT_LEVELS.find((item) => item.value === level)?.label ?? level;
}

const GIT_LINE_SCOPES = new Map<string, GitScopeProvider>(
  GIT_PROVIDERS.flatMap((provider) =>
    gitLevelScopes(provider, "write").map((scope) => [scope, provider] as const)
  )
);

export type AccessWhere =
  | { kind: "everywhere" }
  /** A folder picked by its path in every type's own folder tree ("orders/staging"). */
  | { kind: "folder"; path: string }
  /** Resource IDs per type, as scopes name them. */
  | { kind: "resources"; ids: Partial<Record<AccessTypeId, string[]>> };

export interface ResourceAccessLine {
  kind: "resources";
  role: AccessRole;
  /** Types the line covers, in ACCESS_TYPES order. */
  types: AccessTypeId[];
  where: AccessWhere;
  mayDelete: boolean;
  /** Folder lines only: also manage the folder's subfolders (types with `foldersManage`). */
  manageFolders?: boolean;
}

export type GitRepositories =
  | { kind: "all" }
  /** A GitLab group or GitHub owner, with what it holds now and later. */
  | { kind: "group"; id: string }
  /** GitLab projects or GitHub repositories by ID. */
  | { kind: "some"; ids: string[] };

export interface GitAccessLine {
  kind: "git";
  provider: GitScopeProvider;
  /** null: every connector of the provider (unqualified scopes). */
  connectorId: string | null;
  repositories: GitRepositories;
  level: GitLevel;
}

export interface CustomAccessLine {
  kind: "custom";
  scopes: string[];
}

export type AccessLine = ResourceAccessLine | GitAccessLine | CustomAccessLine;

/** What building and parsing lines need to know: the folders of the eight types' trees. */
export interface AccessContext {
  folders: readonly FolderOption[];
}

export const EMPTY_ACCESS_CONTEXT: AccessContext = { folders: [] };

const folderIndexes = new WeakMap<AccessContext, Map<string, string>>();

function folderId(ctx: AccessContext, family: FolderFamily, path: string): string | null {
  let index = folderIndexes.get(ctx);
  if (!index) {
    index = new Map();
    for (const folder of ctx.folders) {
      const key = `${folder.family}:${folder.label}`;
      if (!index.has(key)) index.set(key, folder.id);
    }
    folderIndexes.set(ctx, index);
  }
  return index.get(`${family}:${path}`) ?? null;
}

/** Folder paths of the given types' trees, sorted, each once. */
export function accessFolderPaths(
  ctx: AccessContext,
  types: readonly AccessTypeId[] = ACCESS_TYPE_IDS
) {
  const families = new Set(types.map((type) => accessType(type).family));
  return [
    ...new Set(
      ctx.folders.filter((folder) => families.has(folder.family)).map((folder) => folder.label)
    ),
  ].sort((a, b) => a.localeCompare(b));
}

/** Types whose tree has no folder at `path`: a folder line leaves them out. */
export function typesWithoutFolder(
  ctx: AccessContext,
  path: string,
  types: readonly AccessTypeId[]
): AccessTypeId[] {
  return types.filter((type) => !folderId(ctx, accessType(type).family, path));
}

type Place =
  | { kind: "everywhere" }
  | { kind: "folder"; path: string }
  | { kind: "resource"; type: AccessTypeId; id: string };

/** A role's scopes in a kind of place: creation scopes name a destination, never a resource. */
function roleScopesAt(type: AccessType, role: AccessRole, kind: Place["kind"]) {
  const scopes = type.roles[role];
  return kind === "resource" ? scopes.filter((scope) => !CREATION_SCOPES.has(scope)) : scopes;
}

function qualify(scope: string, type: AccessType, place: Place, ctx: AccessContext): string | null {
  if (place.kind === "everywhere") return scope;
  if (place.kind === "resource") return `${scope}:${place.id}`;
  const id = folderId(ctx, type.family, place.path);
  return id ? `${scope}:folder/${id}` : null;
}

function typeScopesAt(
  type: AccessType,
  role: AccessRole,
  mayDelete: boolean,
  place: Place,
  ctx: AccessContext
): string[] {
  const scopes = [
    ...roleScopesAt(type, role, place.kind),
    ...(mayDelete && roleCanDelete(role) ? type.delete : []),
  ];
  return scopes.flatMap((scope) => {
    const qualified = qualify(scope, type, place, ctx);
    return qualified ? [qualified] : [];
  });
}

function gitQualifiers(line: GitAccessLine): (string | null)[] {
  if (line.connectorId === null) return [null];
  const kinds = GIT_TARGET_KINDS[line.provider];
  const { repositories } = line;
  if (repositories.kind === "all" || !kinds) return [line.connectorId];
  if (repositories.kind === "group")
    return [`${line.connectorId}/${kinds.container}/${repositories.id}`];
  return repositories.ids.map((id) => `${line.connectorId}/${kinds.repository}/${id}`);
}

/** The ordinary scopes one line stands for. */
export function lineScopes(line: AccessLine, ctx: AccessContext): string[] {
  if (line.kind === "custom") return [...line.scopes];
  if (line.kind === "git") {
    const scopes = gitLevelScopes(line.provider, line.level);
    return gitQualifiers(line).flatMap((qualifier) =>
      scopes.map((scope) => (qualifier ? `${scope}:${qualifier}` : scope))
    );
  }
  const { where } = line;
  if (where.kind === "resources") {
    return line.types.flatMap((typeId) =>
      (where.ids[typeId] ?? []).flatMap((id) =>
        typeScopesAt(
          accessType(typeId),
          line.role,
          line.mayDelete,
          { kind: "resource", type: typeId, id },
          ctx
        )
      )
    );
  }
  return line.types.flatMap((typeId) => [
    ...typeScopesAt(accessType(typeId), line.role, line.mayDelete, where, ctx),
    ...(line.manageFolders ? folderManageScopes(accessType(typeId), where, ctx) : []),
  ]);
}

/** The folder management scope of a type in a folder line ("Manage subfolders"). */
function folderManageScopes(type: AccessType, where: AccessWhere, ctx: AccessContext): string[] {
  if (where.kind !== "folder" || !type.foldersManage) return [];
  const qualified = qualify(type.foldersManage, type, where, ctx);
  return qualified ? [qualified] : [];
}

/**
 * The scopes the lines save as, sorted: Gateway keeps a broad scope and drops its folder- and
 * resource-qualified forms ("Viewer everywhere" covers the view scopes of "Developer in folder
 * orders"), so the count is what is stored.
 */
export function linesToScopes(lines: readonly AccessLine[], ctx: AccessContext): string[] {
  return canonicalizeScopeSelection(lines.flatMap((line) => lineScopes(line, ctx)));
}

/** Per line: whether the other lines already give all of its access (saving drops it). */
export function linesAddingNothing(lines: readonly AccessLine[], ctx: AccessContext): boolean[] {
  const all = linesToScopes(lines, ctx).join("\n");
  return lines.map(
    (_, index) =>
      lines.length > 1 &&
      linesToScopes(
        lines.filter((__, other) => other !== index),
        ctx
      ).join("\n") === all
  );
}

/** A Docker qualifier without `/` is a whole node, never one resource. */
function isResourceQualifier(type: AccessType, qualifier: string) {
  if (qualifier.startsWith("folder/") || qualifier.startsWith("node/")) return false;
  if (type.family === "docker" || type.family === "docker-compose") return qualifier.includes("/");
  return qualifier.length > 0;
}

interface TypeMatch {
  type: AccessType;
  /**
   * Roles whose scopes are exactly the largest set held here (several when their sets are equal);
   * for a covered match, every role held here.
   */
  roles: AccessRole[];
  /** Delete is held here; for a covered match, whether it is held at all. */
  mayDelete: boolean;
  /**
   * Every scope of the type here comes through a broad stored scope: the type joins a line of
   * this place, but never makes one of its own.
   */
  covered: boolean;
  /** For resource places: the resource. */
  id?: string;
}

function sameScopes(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((scope) => b.includes(scope));
}

/**
 * The role a type holds in a place. A scope is held as stored, or, in a folder or on a resource,
 * through its broad form: Gateway keeps `docker:containers:view` and drops
 * `docker:containers:view:folder/<id>` and `docker:containers:view:<node>/<id>` (backend
 * `canonicalizeScopes`; nothing else counts). A role matches only if it holds a scope as stored,
 * so a line is never read out of broad scopes alone.
 */
function matchType(
  type: AccessType,
  place: Place,
  remaining: ReadonlySet<string>,
  broad: ReadonlySet<string>,
  ctx: AccessContext
): TypeMatch | null {
  const stored = (scope: string) => {
    const qualified = qualify(scope, type, place, ctx);
    return qualified !== null && remaining.has(qualified);
  };
  const holds = (scope: string) =>
    stored(scope) ||
    (place.kind !== "everywhere" && broad.has(scope) && qualify(scope, type, place, ctx) !== null);
  const deleteHeld = type.delete.every(holds);
  const deleteAdds = deleteHeld && type.delete.some(stored);
  let best: readonly string[] | null = null;
  let roles: AccessRole[] = [];
  const held: AccessRole[] = [];
  for (const role of ROLE_IDS) {
    const scopes = roleScopesAt(type, role, place.kind);
    if (!scopes.every(holds)) continue;
    held.push(role);
    if (!scopes.some(stored) && !(roleCanDelete(role) && deleteAdds)) continue;
    if (!best || scopes.length > best.length) {
      best = scopes;
      roles = [role];
    } else if (sameScopes(scopes, best)) {
      roles.push(role);
    }
  }
  if (!best) {
    return held.length > 0 ? { type, roles: held, mayDelete: deleteHeld, covered: true } : null;
  }
  const deleting = roles.filter(roleCanDelete);
  if (deleting.length > 0 && deleteAdds) {
    return { type, roles: deleting, mayDelete: true, covered: false };
  }
  return { type, roles, mayDelete: false, covered: false };
}

/**
 * Group matches into as few lines as possible: the role (and delete) shared by most matches goes
 * first; ties take the lower role, so equal scope sets read as the smallest role that grants them.
 * Covered matches join a line whose role (and delete) they hold when that makes it cover all
 * `available` types of the place, the way such a line is usually added; a line on some types
 * stays as it is.
 */
function groupMatches(
  matches: TypeMatch[],
  available = 0
): { role: AccessRole; mayDelete: boolean; matches: TypeMatch[] }[] {
  const groups: { role: AccessRole; mayDelete: boolean; matches: TypeMatch[] }[] = [];
  let left = matches.filter((match) => !match.covered);
  let spare = matches.filter((match) => match.covered);
  while (left.length > 0) {
    let pick: { role: AccessRole; mayDelete: boolean; matches: TypeMatch[] } | null = null;
    for (const role of ROLE_IDS) {
      for (const mayDelete of [false, true]) {
        const covered = left.filter(
          (match) => match.mayDelete === mayDelete && match.roles.includes(role)
        );
        if (covered.length > (pick?.matches.length ?? 0))
          pick = { role, mayDelete, matches: covered };
      }
    }
    if (!pick) break;
    const chosen = pick;
    const holding = spare.filter(
      (match) => match.roles.includes(chosen.role) && (!chosen.mayDelete || match.mayDelete)
    );
    const joining = chosen.matches.length + holding.length === available ? holding : [];
    spare = spare.filter((match) => !joining.includes(match));
    groups.push({ ...chosen, matches: [...chosen.matches, ...joining] });
    left = left.filter((match) => !chosen.matches.includes(match));
  }
  return groups;
}

function typeOrder(a: AccessTypeId, b: AccessTypeId) {
  return ACCESS_TYPE_IDS.indexOf(a) - ACCESS_TYPE_IDS.indexOf(b);
}

/**
 * Stored scopes as lines, best effort and deterministic: roles everywhere, then per folder path,
 * then on single resources; Git levels per connector, group or repositories; whatever is left is
 * one "Custom scopes" line. A folder or resource line counts the scopes a broad stored scope
 * covers (see `matchType`). `linesToScopes` of the result gives the same scopes back, in the
 * form Gateway stores them.
 */
export function scopesToLines(scopes: readonly string[], ctx: AccessContext): AccessLine[] {
  const canonical = canonicalizeScopeSelection(scopes);
  const remaining = new Set(canonical);
  const broad = new Set(canonical.filter((scope) => extractBaseScope(scope) === scope));
  const lines: AccessLine[] = [];
  const consume = (line: AccessLine) => {
    for (const scope of lineScopes(line, ctx)) remaining.delete(scope);
    lines.push(line);
  };

  const folderPaths = new Set<string>();
  const resourcePlaces: Place[] = [];
  const foldersById = new Map(
    ctx.folders.map((folder) => [`${folder.family}:${folder.id}`, folder])
  );
  for (const scope of [...remaining].sort()) {
    const base = extractBaseScope(scope);
    const type = TYPE_BY_SCOPE.get(base);
    if (!type || base === scope) continue;
    const qualifier = scope.slice(base.length + 1);
    if (qualifier.startsWith("folder/")) {
      const folder = foldersById.get(`${type.family}:${qualifier.slice("folder/".length)}`);
      if (folder) folderPaths.add(folder.label);
    } else if (
      isResourceQualifier(type, qualifier) &&
      !resourcePlaces.some(
        (place) => place.kind === "resource" && place.type === type.id && place.id === qualifier
      )
    ) {
      resourcePlaces.push({ kind: "resource", type: type.id, id: qualifier });
    }
  }

  const places: Place[] = [
    { kind: "everywhere" },
    ...[...folderPaths]
      .sort((a, b) => a.localeCompare(b))
      .map((path) => ({ kind: "folder" as const, path })),
  ];
  for (const place of places) {
    const matches = ACCESS_TYPES.flatMap((type) => {
      const match = matchType(type, place, remaining, broad, ctx);
      return match ? [match] : [];
    });
    const available =
      place.kind === "folder"
        ? ACCESS_TYPE_IDS.length - typesWithoutFolder(ctx, place.path, ACCESS_TYPE_IDS).length
        : ACCESS_TYPE_IDS.length;
    for (const group of groupMatches(matches, available)) {
      const types = group.matches.map((match) => match.type.id).sort(typeOrder);
      const where: AccessWhere =
        place.kind === "folder" ? { kind: "folder", path: place.path } : { kind: "everywhere" };
      // "Manage subfolders" reads back when every type of the line that has it holds it here.
      const manageScopes = types.flatMap((type) =>
        folderManageScopes(accessType(type), where, ctx)
      );
      const manageFolders =
        manageScopes.length > 0 && manageScopes.every((scope) => remaining.has(scope));
      consume({
        kind: "resources",
        role: group.role,
        mayDelete: group.mayDelete,
        ...(manageFolders ? { manageFolders } : {}),
        types,
        where,
      });
    }
  }

  // A resource joins a line only through a scope stored for it.
  const resourceMatches = resourcePlaces.flatMap((place) => {
    if (place.kind !== "resource") return [];
    const match = matchType(accessType(place.type), place, remaining, broad, ctx);
    return match && !match.covered ? [{ ...match, id: place.id }] : [];
  });
  for (const group of groupMatches(resourceMatches)) {
    const ids: Partial<Record<AccessTypeId, string[]>> = {};
    for (const match of group.matches)
      ids[match.type.id] = [...(ids[match.type.id] ?? []), match.id!];
    consume({
      kind: "resources",
      role: group.role,
      mayDelete: group.mayDelete,
      types: (Object.keys(ids) as AccessTypeId[]).sort(typeOrder),
      where: { kind: "resources", ids },
    });
  }

  for (const line of parseGitLines(remaining)) consume(line);

  if (remaining.size > 0) lines.push({ kind: "custom", scopes: [...remaining].sort() });
  return lines;
}

function parseGitLines(remaining: ReadonlySet<string>): GitAccessLine[] {
  const groups = new Map<
    string,
    { provider: GitScopeProvider; qualifier: string | null; bases: Set<string> }
  >();
  for (const scope of remaining) {
    const base = extractBaseScope(scope);
    const provider = GIT_LINE_SCOPES.get(base);
    if (!provider) continue;
    const qualifier = base === scope ? null : scope.slice(base.length + 1);
    const key = `${GIT_PROVIDERS.indexOf(provider)}|${qualifier ?? ""}`;
    const group = groups.get(key) ?? { provider, qualifier, bases: new Set<string>() };
    group.bases.add(base);
    groups.set(key, group);
  }
  const lines: GitAccessLine[] = [];
  for (const key of [...groups.keys()].sort()) {
    const { provider, qualifier, bases } = groups.get(key)!;
    const level = [...GIT_LEVELS]
      .reverse()
      .find((item) =>
        gitLevelScopes(provider, item.value).every((scope) => bases.has(scope))
      )?.value;
    if (!level) continue;
    const line = gitLineFor(provider, qualifier, level);
    if (!line) continue;
    const previous = lines.find(
      (candidate) =>
        line.repositories.kind === "some" &&
        candidate.repositories.kind === "some" &&
        candidate.provider === line.provider &&
        candidate.connectorId === line.connectorId &&
        candidate.level === line.level
    );
    if (previous && previous.repositories.kind === "some" && line.repositories.kind === "some") {
      previous.repositories.ids = [...previous.repositories.ids, ...line.repositories.ids].sort();
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function gitLineFor(
  provider: GitScopeProvider,
  qualifier: string | null,
  level: GitLevel
): GitAccessLine | null {
  if (qualifier === null)
    return { kind: "git", provider, connectorId: null, repositories: { kind: "all" }, level };
  const parts = qualifier.split("/");
  if (parts.length === 1)
    return { kind: "git", provider, connectorId: parts[0]!, repositories: { kind: "all" }, level };
  const kinds = GIT_TARGET_KINDS[provider];
  if (!kinds || parts.length !== 3 || !parts[0] || !parts[2]) return null;
  if (parts[1] === kinds.container) {
    return {
      kind: "git",
      provider,
      connectorId: parts[0],
      repositories: { kind: "group", id: parts[2] },
      level,
    };
  }
  if (parts[1] === kinds.repository) {
    return {
      kind: "git",
      provider,
      connectorId: parts[0],
      repositories: { kind: "some", ids: [parts[2]] },
      level,
    };
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * Text of a line.
 * ---------------------------------------------------------------------------------------------- */

export interface AccessLabels {
  /** A resource's name, by type and the ID scopes use. */
  resource?: (type: AccessTypeId, id: string) => string | undefined;
  /** A connector's name. */
  connector?: (provider: GitScopeProvider, connectorId: string) => string | undefined;
  /** A group, owner, project or repository path, by provider and qualifier. */
  gitTarget?: (provider: GitScopeProvider, qualifier: string) => string | undefined;
}

export function folderPathLabel(path: string) {
  return path.split("/").join(" / ");
}

/** Types inside a sentence: "routes, SSL certificates, databases". */
export function typesText(types: readonly AccessTypeId[]) {
  return [...types]
    .sort(typeOrder)
    .map((type) => accessType(type).inline)
    .join(", ");
}

export function coversLabel(types: readonly AccessTypeId[]) {
  if (types.length === ACCESS_TYPES.length) return `All ${ACCESS_TYPES.length} resource types`;
  const text = typesText(types);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A Docker resource whose name is not known here (`<nodeId>/<resourceId>`): its kind and short ID, not both IDs. */
function unnamedResourceLabel(type: AccessTypeId, id: string) {
  const slash = id.indexOf("/");
  if (slash < 0) return id;
  const resourceId = id.slice(slash + 1);
  return `${type === "compose" ? "Compose project" : "container"} ${resourceId.slice(0, 12)}`;
}

function resourceNames(where: Extract<AccessWhere, { kind: "resources" }>, labels: AccessLabels) {
  return (Object.keys(where.ids) as AccessTypeId[])
    .sort(typeOrder)
    .flatMap((type) =>
      (where.ids[type] ?? []).map(
        (id) => labels.resource?.(type, id) ?? unnamedResourceLabel(type, id)
      )
    );
}

/** "everywhere", "in folder orders / staging", "on orders-api, orders-web" or "on 3 resources". */
export function whereLabel(where: AccessWhere, labels: AccessLabels = {}) {
  if (where.kind === "everywhere") return "everywhere";
  if (where.kind === "folder") return `in folder ${folderPathLabel(where.path)}`;
  const names = resourceNames(where, labels);
  return names.length <= 2 ? `on ${names.join(", ")}` : `on ${names.length} resources`;
}

function gitTargetText(line: GitAccessLine, labels: AccessLabels) {
  const kinds = GIT_TARGET_KINDS[line.provider];
  const { repositories } = line;
  if (repositories.kind === "all" || !kinds || line.connectorId === null) return "every repository";
  if (repositories.kind === "group") {
    const qualifier = `${line.connectorId}/${kinds.container}/${repositories.id}`;
    return `${kinds.container} ${labels.gitTarget?.(line.provider, qualifier) ?? repositories.id}`;
  }
  if (repositories.ids.length === 1) {
    const qualifier = `${line.connectorId}/${kinds.repository}/${repositories.ids[0]}`;
    return labels.gitTarget?.(line.provider, qualifier) ?? `repository ${repositories.ids[0]}`;
  }
  return `${repositories.ids.length} repositories`;
}

export function gitConnectorLabel(
  provider: GitScopeProvider,
  connectorId: string | null,
  labels: AccessLabels = {}
) {
  const providerTitle = GIT_PROVIDER_TITLES[provider];
  if (connectorId === null) return `Every ${providerTitle} connector`;
  return `${providerTitle} · ${labels.connector?.(provider, connectorId) ?? connectorId}`;
}

const SCOPE_LABELS = new Map<string, string>(
  TOKEN_SCOPES.map((scope) => [scope.value, scope.label])
);

/** The text of a line: "Developer in folder orders" over "All 8 resource types · may delete". */
export function describeLine(
  line: AccessLine,
  labels: AccessLabels = {}
): { title: string; detail: string } {
  if (line.kind === "custom") {
    const names = [
      ...new Set(line.scopes.map((scope) => SCOPE_LABELS.get(extractBaseScope(scope)) ?? scope)),
    ];
    const shown = names.slice(0, 3).join(", ");
    return {
      title: "Custom scopes",
      detail: names.length > 3 ? `${shown} and ${names.length - 3} more` : shown,
    };
  }
  if (line.kind === "git") {
    const target = gitTargetText(line, labels);
    const level = gitLevelLabel(line.level);
    return {
      title: line.level === "use" ? `Use ${target}` : `${level} in ${target}`,
      detail: gitConnectorLabel(line.provider, line.connectorId, labels),
    };
  }
  return {
    title: `${roleTitle(line.role)} ${whereLabel(line.where, labels)}`,
    detail: `${coversLabel(line.types)}${line.mayDelete ? " · may delete" : ""}${
      line.manageFolders ? " · manages subfolders" : ""
    }`,
  };
}

/* ------------------------------------------------------------------------------------------------
 * What a token line really does: its scopes bounded by the owner's, as the backend bounds tokens.
 * ---------------------------------------------------------------------------------------------- */

const IMPLIED_BY_SCOPE = new Map<string, string[]>();
for (const [required, implying] of Object.entries(IMPLIED_SCOPES_BY_REQUIRED_SCOPE)) {
  for (const scope of implying)
    IMPLIED_BY_SCOPE.set(scope, [...(IMPLIED_BY_SCOPE.get(scope) ?? []), required]);
}

const DOCKER_CHILD_PREFIXES = ["docker:containers:", "docker:compose:", "docker:availability:"];

function parentResourceId(base: string, resourceId: string): string | null {
  if (
    GIT_LINE_SCOPES.has(base) ||
    DOCKER_CHILD_PREFIXES.some((prefix) => base.startsWith(prefix))
  ) {
    if (resourceId.startsWith("folder/") || resourceId.startsWith("node/")) return null;
    const separator = resourceId.indexOf("/");
    return separator > 0 ? resourceId.slice(0, separator) : null;
  }
  return null;
}

/** Whether `principal` holds `scope`, counting a grant on a folder for its subfolders. */
export function principalHolds(principal: readonly string[], scope: string, ctx: AccessContext) {
  if (scopeMatches(principal, scope)) return true;
  const base = extractBaseScope(scope);
  const qualifier = scope.slice(base.length + 1);
  if (base === scope || !qualifier.startsWith("folder/")) return false;
  const id = qualifier.slice("folder/".length);
  const folder = ctx.folders.find((candidate) => candidate.id === id);
  return !!folder?.ancestorIds.some((ancestor) =>
    scopeMatches(principal, `${base}:folder/${ancestor}`)
  );
}

/**
 * The delegated scopes a principal's scopes leave standing (backend `boundScopes`, steps 1-3):
 * what it holds of them, and broad delegated scopes narrowed to the resources it holds them for.
 */
export function boundAccessScopes(
  delegated: readonly string[],
  principal: readonly string[],
  ctx: AccessContext = EMPTY_ACCESS_CONTEXT
): string[] {
  const bounded = new Set<string>();
  const delegatedSet = new Set(delegated);
  for (const scope of delegated) if (principalHolds(principal, scope, ctx)) bounded.add(scope);
  for (const scope of principal) {
    const base = extractBaseScope(scope);
    if (delegatedSet.has(scope)) {
      bounded.add(scope);
      continue;
    }
    if (scope === base) continue;
    const resourceId = scope.slice(base.length + 1);
    const parentId = parentResourceId(base, resourceId);
    if (delegatedSet.has(base) || (parentId && delegatedSet.has(`${base}:${parentId}`)))
      bounded.add(scope);
  }
  for (const scope of principal) {
    const base = extractBaseScope(scope);
    if (scope === base) continue;
    const resourceId = scope.slice(base.length + 1);
    for (const delegatedBase of [base, ...(IMPLIED_BY_SCOPE.get(base) ?? [])]) {
      const parentId = parentResourceId(delegatedBase, resourceId);
      if (
        !delegatedSet.has(delegatedBase) &&
        !(parentId && delegatedSet.has(`${delegatedBase}:${parentId}`))
      ) {
        continue;
      }
      const narrowed = `${delegatedBase}:${resourceId}`;
      if (scopeMatches([scope], narrowed)) bounded.add(narrowed);
    }
  }
  return [...bounded].sort();
}

/**
 * The scopes a token saves as: its lines' scopes the owner holds, a wider line narrowed to the
 * owner's part (the backend refuses scopes the owner lacks), in stored form. The token dialog asks
 * Gateway to store exactly these (`exactScopes`), so nothing is added for older scripts.
 */
export function tokenStoredScopes(
  scopes: readonly string[],
  ownerScopes: readonly string[],
  ctx: AccessContext
): string[] {
  const holds = (scope: string) => principalHolds(ownerScopes, scope, ctx);
  const held = scopes.filter(holds);
  const heldSet = new Set(held);
  const narrowed =
    held.length === scopes.length
      ? []
      : boundAccessScopes(
          scopes.filter((scope) => !heldSet.has(scope)),
          ownerScopes,
          ctx
        ).filter(holds);
  return canonicalizeScopeSelection([...held, ...narrowed]);
}

function shortWhere(where: AccessWhere) {
  if (where.kind === "everywhere") return "everywhere";
  if (where.kind === "folder") return `in ${folderPathLabel(where.path)}`;
  return "on these resources";
}

/**
 * For a line wider than its owner's access, what it really does: "Works as Deployer: you are
 * Deployer in billing". Null when the owner holds all of it.
 */
export function narrowedNote(
  line: AccessLine,
  ownerScopes: readonly string[],
  ctx: AccessContext,
  labels: AccessLabels = {}
): string | null {
  const scopes = lineScopes(line, ctx);
  if (scopes.every((scope) => principalHolds(ownerScopes, scope, ctx))) return null;
  const bounded = boundAccessScopes(scopes, ownerScopes, ctx);
  const parsed = scopesToLines(bounded, ctx).filter((item) => item.kind !== "custom");
  if (parsed.length === 0) return "Does nothing: you hold none of this access";
  const [only] = parsed;
  if (
    parsed.length === 1 &&
    line.kind === "resources" &&
    only?.kind === "resources" &&
    JSON.stringify(only.where) === JSON.stringify(line.where)
  ) {
    const role = roleTitle(only.role);
    return `Works as ${role}: you are ${role} ${shortWhere(line.where)}`;
  }
  const titles = parsed.map((item) => describeLine(item, labels).title);
  return `Works as ${titles.slice(0, 2).join("; ")}${titles.length > 2 ? ` and ${titles.length - 2} more` : ""}`;
}
