import { describe, expect, it } from 'vitest';
import {
  gitConnectorGrant,
  gitGrantCovers,
  gitGrantedConnectorIds,
  gitGrantNeedsLookup,
  gitGrantsCover,
  gitRepositoryQualifiers,
  hasGitConnectorScope,
  hasGitGrants,
  hasGitRepositoryScope,
  hasGitScopeOnConnector,
  principalGitConnectorGrants,
  principalHasGitRepositoryScope,
} from './git-scopes.js';
import { boundScopes, hasScope, isScopeSubset, privilegeBoundaryScopes } from './permissions.js';
import { canonicalizeScopes, extractBaseScope, isApiTokenScope, isValidInboundScope } from './scopes.js';
import { DelegatedScopeArraySchema, delegatedScopeIssue } from './scopes-schemas.js';

const C = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const READ = 'integrations:gitlab:repo:read';
const VIEW = 'integrations:gitlab:view';

/** GitLab project 42 in group 7, a subgroup of group 3. */
const PROJECT = { connectorId: C, repositoryId: '42', containerIds: ['7', '3'] };
/** GitHub repository 1011 owned by organization 789. */
const REPO = { connectorId: C, repositoryId: '1011', containerIds: ['789'] };

describe('Git scope qualifier grammar', () => {
  it.each([
    `${READ}:${C}`,
    `${READ}:${C}/group/7`,
    `${READ}:${C}/project/42`,
    `integrations:gitlab:sandbox:clone:${C}/group/7`,
    `integrations:github:use:${C}/owner/789`,
    `integrations:github:repo:write:${C}/repo/1011`,
    `integrations:git:repo:read:${C}`,
    `integrations:gitlab:manage:${C}`,
  ])('accepts %s', (scope) => {
    expect(delegatedScopeIssue(scope)).toBeNull();
    expect(isValidInboundScope(scope)).toBe(true);
    expect(isApiTokenScope(scope)).toBe(!scope.includes('sandbox:clone'));
  });

  it.each([
    [`${READ}:${C}/owner/7`, 'targets must be'],
    [`integrations:github:view:${C}/group/7`, 'targets must be'],
    [`integrations:git:repo:read:${C}/project/42`, 'only be restricted to a connector'],
    [`integrations:gitlab:manage:${C}/group/7`, 'only be restricted to a connector'],
    [`${READ}:acme/platform`, 'Git scope targets must be'],
    [`${READ}:${C}/group/acme`, 'Git scope targets must be'],
    [`${READ}:${C}/group/0`, 'Git scope targets must be'],
    [`${READ}:ABCDEF01-2345-4678-89AB-CDEF01234567`, 'Git scope targets must be'],
    [`${READ}:folder/${C}`, 'Git scope targets must be'],
    [`${READ}:node/${C}`, 'Git scope targets must be'],
    [`${READ}:${C}/group/7/project/42`, 'Git scope targets must be'],
  ])('rejects %s', (scope, issue) => {
    expect(delegatedScopeIssue(scope)).toContain(issue);
    expect(isValidInboundScope(scope)).toBe(false);
  });

  it('validates qualifiers wherever groups, tokens and OAuth grants accept scopes', () => {
    expect(DelegatedScopeArraySchema.safeParse([`${READ}:${C}/group/7`, `${VIEW}:${C}`]).success).toBe(true);
    const invalid = DelegatedScopeArraySchema.safeParse([`${READ}:${C}/owner/7`]);
    expect(invalid.success).toBe(false);
    expect(invalid.error?.issues[0]?.message).toContain(`${READ} targets must be`);
  });

  it('keeps retired names with their qualifier', () => {
    expect(delegatedScopeIssue(`integrations:gitlab:ci:view:${C}/project/42`)).toBeNull();
    expect(delegatedScopeIssue(`integrations:gitlab:sync:${C}`)).toBeNull();
    expect(delegatedScopeIssue(`integrations:gitlab:sync:${C}/group/7`)).toContain('only be restricted to a connector');
  });

  it('parses qualified scopes to their Git base', () => {
    expect(extractBaseScope(`${READ}:${C}/group/7`)).toBe(READ);
    expect(extractBaseScope(`integrations:gitlab:sandbox:clone:${C}/project/42`)).toBe(
      'integrations:gitlab:sandbox:clone'
    );
    expect(extractBaseScope(`integrations:github:manage:${C}`)).toBe('integrations:github:manage');
  });
});

describe('Git repository scope matching', () => {
  it('lists the candidate qualifiers broadest first', () => {
    expect(gitRepositoryQualifiers('gitlab', PROJECT)).toEqual([C, `${C}/group/7`, `${C}/group/3`, `${C}/project/42`]);
    expect(gitRepositoryQualifiers('github', REPO)).toEqual([C, `${C}/owner/789`, `${C}/repo/1011`]);
    expect(gitRepositoryQualifiers('git', REPO)).toEqual([C]);
  });

  it.each([
    ['unqualified', [READ], true],
    ['connector', [`${READ}:${C}`], true],
    ['namespace group', [`${READ}:${C}/group/7`], true],
    ['ancestor group', [`${READ}:${C}/group/3`], true],
    ['exact project', [`${READ}:${C}/project/42`], true],
    ['another connector', [`${READ}:${OTHER}`], false],
    ['an unrelated group', [`${READ}:${C}/group/8`], false],
    ['another project', [`${READ}:${C}/project/43`], false],
    ['view only', [`${VIEW}:${C}`], false],
    ['write on the project (no repo tiers)', [`integrations:gitlab:repo:write:${C}/project/42`], false],
  ])('GitLab repo:read through %s', (_label, scopes, allowed) => {
    expect(hasGitRepositoryScope(scopes, READ, PROJECT)).toBe(allowed);
  });

  it.each([
    ['owner', [`integrations:github:repo:read:${C}/owner/789`], true],
    ['exact repository', [`integrations:github:repo:read:${C}/repo/1011`], true],
    ['connector', [`integrations:github:repo:read:${C}`], true],
    ['another owner', [`integrations:github:repo:read:${C}/owner/790`], false],
    ['another repository', [`integrations:github:repo:read:${C}/repo/1012`], false],
    ['the GitLab scope', [`${READ}:${C}`], false],
  ])('GitHub repo:read through %s', (_label, scopes, allowed) => {
    expect(hasGitRepositoryScope(scopes, 'integrations:github:repo:read', REPO)).toBe(allowed);
  });

  it('applies implied view per qualifier', () => {
    expect(hasGitRepositoryScope([`${READ}:${C}/group/3`], VIEW, PROJECT)).toBe(true);
    expect(hasGitRepositoryScope([`integrations:gitlab:use:${C}/project/42`], VIEW, PROJECT)).toBe(true);
    expect(hasGitRepositoryScope([`integrations:gitlab:sandbox:clone:${C}/project/42`], VIEW, PROJECT)).toBe(true);
    expect(hasGitRepositoryScope([`integrations:gitlab:use:${C}/project/43`], VIEW, PROJECT)).toBe(false);
    // View never grants an action.
    expect(hasGitRepositoryScope([`${VIEW}:${C}`], 'integrations:gitlab:use', PROJECT)).toBe(false);
    // hasScope sees the connector as the parent of its narrower qualifiers.
    expect(hasScope([`${READ}:${C}`], `${VIEW}:${C}/project/42`)).toBe(true);
    expect(hasScope([`${READ}:${C}/group/7`], `${VIEW}:${C}`)).toBe(false);
  });

  it('keeps connector-level operations on the connector or unqualified scope', () => {
    expect(hasGitConnectorScope(['integrations:gitlab:manage'], 'integrations:gitlab:manage', C)).toBe(true);
    expect(hasGitConnectorScope([`integrations:gitlab:manage:${C}`], 'integrations:gitlab:manage', C)).toBe(true);
    expect(hasGitConnectorScope([`integrations:gitlab:manage:${OTHER}`], 'integrations:gitlab:manage', C)).toBe(false);
    expect(hasGitConnectorScope([`${VIEW}:${C}/group/7`], VIEW, C)).toBe(false);
    expect(hasGitScopeOnConnector([`${VIEW}:${C}/group/7`], VIEW, C)).toBe(true);
    expect(hasGitScopeOnConnector([`${VIEW}:${OTHER}/group/7`], VIEW, C)).toBe(false);
  });

  it('summarizes the grants on one connector for list filters', () => {
    const scopes = [
      `${READ}:${C}/group/7`,
      `integrations:gitlab:repo:write:${C}/project/42`,
      `integrations:gitlab:use:${C}/project/43`,
      `${READ}:${OTHER}/group/1`,
    ];
    const view = gitConnectorGrant(scopes, VIEW, C);
    expect(view).toEqual({
      connectorWide: false,
      containerIds: new Set(['7']),
      repositoryIds: new Set(['42', '43']),
    });
    expect(gitConnectorGrant(scopes, READ, C).repositoryIds).toEqual(new Set());
    expect(gitGrantCovers(view, { repositoryId: '99', containerIds: ['7'] })).toBe(true);
    expect(gitGrantCovers(view, { repositoryId: '43' })).toBe(true);
    expect(gitGrantCovers(view, { repositoryId: '99', containerIds: ['8'] })).toBe(false);
    expect(gitGrantedConnectorIds(scopes, VIEW)).toEqual({ all: false, connectorIds: new Set([C, OTHER]) });
    expect(gitGrantedConnectorIds(['integrations:gitlab:manage'], VIEW)).toEqual({
      all: true,
      connectorIds: new Set(),
    });
  });

  it('looks up provider data only when a narrower grant still needs it', () => {
    expect(gitGrantNeedsLookup([READ], [READ], C, { repositoryId: '42' })).toBe(false);
    expect(gitGrantNeedsLookup([`${READ}:${C}/project/42`], [READ], C, { repositoryId: '42' })).toBe(false);
    expect(gitGrantNeedsLookup([`${READ}:${C}/group/7`], [READ], C, { repositoryId: '42' })).toBe(true);
    expect(gitGrantNeedsLookup([`${READ}:${OTHER}/group/7`], [READ], C, { repositoryId: '42' })).toBe(false);
    // GitHub repository IDs are unknown until looked up.
    expect(gitGrantNeedsLookup([`integrations:github:use:${C}/repo/1011`], ['integrations:github:use'], C)).toBe(true);
  });
});

describe('Git scope bounding for tokens and OAuth grants', () => {
  it('keeps a delegated qualifier the owner covers', () => {
    expect(boundScopes([`${READ}:${C}/group/7`], [READ])).toEqual([`${READ}:${C}/group/7`]);
    expect(boundScopes([`${READ}:${C}/project/42`], [`${READ}:${C}`])).toEqual([`${READ}:${C}/project/42`]);
    expect(boundScopes([`${VIEW}:${C}/group/7`], [`integrations:gitlab:repo:write:${C}`])).toEqual([
      `${VIEW}:${C}/group/7`,
    ]);
  });

  it('narrows a broader token to the owner qualifiers', () => {
    expect(boundScopes([READ], [`${READ}:${C}/group/7`])).toEqual([`${READ}:${C}/group/7`]);
    expect(boundScopes([`${READ}:${C}`], [`${READ}:${C}/project/42`])).toEqual([`${READ}:${C}/project/42`]);
    // Through implied view, from the unqualified scope and from the connector qualifier.
    expect(boundScopes([VIEW], [`integrations:gitlab:use:${C}/project/42`])).toEqual([`${VIEW}:${C}/project/42`]);
    expect(boundScopes([`${VIEW}:${C}`], [`${READ}:${C}/group/7`])).toEqual([`${VIEW}:${C}/group/7`]);
  });

  it('drops what the owner does not hold', () => {
    expect(boundScopes([`${READ}:${C}/group/7`], [`${READ}:${OTHER}`])).toEqual([]);
    expect(boundScopes([`integrations:gitlab:repo:write:${C}/group/7`], [`${READ}:${C}`])).toEqual([]);
    expect(boundScopes([`${READ}:${C}`], [`${READ}:${C}/group/7`, `${VIEW}:${C}`])).toEqual([`${READ}:${C}/group/7`]);
    // A narrow token scope needs the owner to hold the scope (or one implying it) on the same connector.
    expect(boundScopes([`${READ}:${C}/project/42`], [`${READ}:${OTHER}/group/7`])).toEqual([]);
    expect(boundScopes([`integrations:gitlab:repo:write:${C}/project/42`], [`${READ}:${C}/group/7`])).toEqual([]);
  });

  it('keeps narrow token scopes whose containment only the provider knows, for request-time checks', () => {
    // Owner group G, token project P: kept; P must lie in G at request time.
    expect(boundScopes([`${READ}:${C}/project/42`], [`${READ}:${C}/group/7`])).toEqual([`${READ}:${C}/project/42`]);
    // Owner project P, token group G: kept; only P is allowed at request time.
    expect(boundScopes([`${READ}:${C}/group/7`], [`${READ}:${C}/project/42`])).toEqual([`${READ}:${C}/group/7`]);
    // Through implied view, and for GitHub owners and repositories.
    expect(boundScopes([`${VIEW}:${C}/project/42`], [`integrations:gitlab:use:${C}/group/7`])).toEqual([
      `${VIEW}:${C}/project/42`,
    ]);
    expect(
      boundScopes([`integrations:github:repo:read:${C}/repo/1011`], [`integrations:github:repo:read:${C}/owner/789`])
    ).toEqual([`integrations:github:repo:read:${C}/repo/1011`]);
  });

  it('requires both the token and its owner to cover the repository', () => {
    const owner = [`${READ}:${C}/group/7`];
    const token = {
      scopes: boundScopes([`${READ}:${C}/project/42`, `${READ}:${C}/project/43`], owner),
      accountScopes: owner,
    };
    // Project 42 lies in group 7; project 43 lies in group 8.
    expect(principalHasGitRepositoryScope(token, READ, PROJECT)).toBe(true);
    expect(
      principalHasGitRepositoryScope(token, READ, { connectorId: C, repositoryId: '43', containerIds: ['8'] })
    ).toBe(false);
    // Without owner scopes (a browser session) only the request scopes count.
    expect(principalHasGitRepositoryScope({ scopes: token.scopes }, READ, { connectorId: C, repositoryId: '43' })).toBe(
      true
    );

    const projectOwner = [`${READ}:${C}/project/42`];
    const groupToken = { scopes: boundScopes([`${READ}:${C}/group/7`], projectOwner), accountScopes: projectOwner };
    expect(principalHasGitRepositoryScope(groupToken, READ, PROJECT)).toBe(true);
    expect(
      principalHasGitRepositoryScope(groupToken, READ, { connectorId: C, repositoryId: '44', containerIds: ['7', '3'] })
    ).toBe(false);
    const grants = principalGitConnectorGrants(groupToken, VIEW, C);
    expect(gitGrantsCover(grants, { repositoryId: '42', containerIds: ['7'] })).toBe(true);
    expect(gitGrantsCover(grants, { repositoryId: '44', containerIds: ['7'] })).toBe(false);
    expect(hasGitGrants(grants)).toBe(true);
  });

  it('never lets a token grant or manage through narrow scopes its owner covers only by containment', () => {
    const owner = [`${READ}:${C}/group/7`, 'admin:groups'];
    const tokenScopes = boundScopes([`${READ}:${C}/project/42`, `${READ}:${C}/group/7`, 'admin:groups'], owner);
    const boundary = privilegeBoundaryScopes(tokenScopes, owner, 'grant');
    expect(boundary).toContain(`${READ}:${C}/group/7`);
    expect(boundary).not.toContain(`${READ}:${C}/project/42`);
    expect(isScopeSubset([`${READ}:${C}/project/99`], boundary)).toBe(false);
  });

  it('bounds generic Git and connector management by the connector', () => {
    expect(boundScopes(['integrations:git:repo:write'], [`integrations:git:repo:write:${C}`])).toEqual([
      `integrations:git:repo:write:${C}`,
    ]);
    expect(boundScopes([`integrations:gitlab:manage:${C}`], ['integrations:gitlab:manage'])).toEqual([
      `integrations:gitlab:manage:${C}`,
    ]);
  });

  it('lets delegated administrators grant what their qualifiers cover', () => {
    expect(isScopeSubset([`${READ}:${C}/group/7`], [`${READ}:${C}`])).toBe(true);
    expect(isScopeSubset([`${READ}:${C}`], [`${READ}:${C}/group/7`])).toBe(false);
    expect(canonicalizeScopes([`${READ}:${C}/group/7`, READ])).toEqual([READ]);
  });
});
