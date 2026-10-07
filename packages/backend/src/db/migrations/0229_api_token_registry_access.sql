-- Internal registry access becomes a property of an API token (pull and push each "all" or a list of repositories)
-- instead of a user scope. Existing tokens keep their docker:registries:internal:pull|push scopes, which Gateway
-- still reads as registry access (modules/tokens/token-registry-access.ts), so nothing is rewritten here and a
-- release before this one keeps working with the same rows.
ALTER TABLE "api_tokens" ADD COLUMN "registry_access" jsonb DEFAULT '{}'::jsonb NOT NULL;
