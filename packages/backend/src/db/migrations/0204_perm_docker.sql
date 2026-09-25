-- Deployment rename, delete and migration used to leave the folder placement behind (keyed by the old name on the
-- old node). A later workload with that name on that node silently joined the folder and was exposed to its users.
-- Remove container placements that no workload can own any more. A row is kept when any of these still uses the key
-- on its node: a deployment, a container access identity (every container Gateway has seen or created has one) or a
-- container Git source binding (a container waiting for its first build). Nodes that never recorded a container
-- identity are skipped, because there a missing identity proves nothing.
DELETE FROM "docker_container_folder_assignments" AS "assignment"
WHERE "assignment"."resource_type" = 'container'
  AND EXISTS (
    SELECT 1 FROM "docker_access_resources" AS "seen"
    WHERE "seen"."node_id" = "assignment"."node_id" AND "seen"."resource_type" = 'container'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "docker_deployments" AS "deployment"
    WHERE "deployment"."node_id" = "assignment"."node_id" AND "deployment"."name" = "assignment"."resource_key"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "docker_access_resources" AS "identity"
    WHERE "identity"."node_id" = "assignment"."node_id"
      AND "identity"."resource_type" = 'container'
      AND "identity"."resource_key" = "assignment"."resource_key"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "docker_source_bindings" AS "binding"
    WHERE "binding"."target_kind" = 'container'
      AND "binding"."node_id" = "assignment"."node_id"
      AND "binding"."container_name" = "assignment"."resource_key"
  );
