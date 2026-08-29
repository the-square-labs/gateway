UPDATE "oauth_access_tokens"
SET "revoked_at" = NOW()
WHERE "expires_at" IS NULL
  AND "revoked_at" IS NULL
  AND "resource" LIKE '%/api/mcp';
