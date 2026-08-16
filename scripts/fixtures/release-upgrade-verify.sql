\set ON_ERROR_STOP on

DO $$
DECLARE
  migration_count integer;
  preserved_count integer;
  legacy_node uuid;
  wildcard_node uuid;
BEGIN
  SELECT count(*) INTO migration_count
  FROM drizzle.__drizzle_migrations
  WHERE id BETWEEN 116 AND 123;
  IF migration_count <> 8 THEN
    RAISE EXCEPTION 'expected migrations 116-123 exactly once, found %', migration_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.referential_constraints
    WHERE constraint_schema = 'public'
      AND constraint_name = 'docker_container_folder_assignments_folder_id_docker_container_folders_id_fk'
      AND delete_rule = 'SET NULL'
  ) THEN
    RAISE EXCEPTION 'docker folder assignment foreign key does not use ON DELETE SET NULL';
  END IF;

  SELECT count(*) INTO preserved_count
  FROM nodes
  WHERE id IN (
    '11000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000002',
    '11000000-0000-4000-8000-000000000003'
  );
  IF preserved_count <> 3 THEN
    RAISE EXCEPTION 'legacy nodes were not preserved';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM proxy_hosts
    WHERE id = '15000000-0000-4000-8000-000000000001'
      AND node_id = '11000000-0000-4000-8000-000000000001'
      AND domain_names = '["legacy.example.test"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'legacy proxy host was not preserved';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM docker_container_folder_assignments
    WHERE id = '17000000-0000-4000-8000-000000000001'
      AND folder_id = '16000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'legacy Docker folder assignment was not preserved';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM integration_connectors
    WHERE id = '18000000-0000-4000-8000-000000000001'
      AND auth_mode = 'token'
      AND username IS NULL
  ) THEN
    RAISE EXCEPTION 'legacy connector was not preserved or OAuth defaults are invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM settings
    WHERE key = 'release:e2e:sentinel'
      AND value = '{"value":"v2.6.12"}'::jsonb
  ) THEN
    RAISE EXCEPTION 'settings sentinel was not preserved';
  END IF;

  SELECT nginx_node_id INTO legacy_node
  FROM domains WHERE id = '14000000-0000-4000-8000-000000000001';
  IF legacy_node <> '11000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'proxy-backed domain selected wrong ingress node: %', legacy_node;
  END IF;

  SELECT nginx_node_id INTO wildcard_node
  FROM domains WHERE id = '14000000-0000-4000-8000-000000000002';
  IF wildcard_node IS NULL THEN
    RAISE EXCEPTION 'unattached legacy domain was not assigned to an eligible ingress node';
  END IF;

  IF to_regclass('public.external_ssh_connectors') IS NULL
    OR to_regclass('public.ai_run_setup_interactions') IS NULL
    OR to_regclass('public.integration_github_oauth_sessions') IS NULL THEN
    RAISE EXCEPTION 'one or more migration-created tables are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'domains' AND column_name = 'ingress_migration_status'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'external_ssh_connectors' AND column_name = 'test_status'
  ) THEN
    RAISE EXCEPTION 'one or more migration-created columns are missing';
  END IF;
END $$;

SELECT 'release upgrade database verification passed' AS result;
