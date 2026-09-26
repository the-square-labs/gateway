-- Data as a v2.11.0-rc.10 install (schema through 0206_pages_preview_links) can hold it, including the collisions
-- rc.10 could store and that migrations 0207-0209 must survive: two deployments on one host port, a database on a
-- storage cluster's port, duplicate storage names, two enabled proxy hosts serving one name, several active backups
-- of one policy and restores into one new database, an Availability replica, and a settings-row operation lease.
-- Used by migrations.upgrade.database.test.ts. Every id is fixed so the test can name rows.

INSERT INTO "permission_groups" ("id", "name") VALUES ('00000000-0000-4000-8000-000000000001', 'rc10-upgrade');
INSERT INTO "users" ("id", "group_id", "email", "name")
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'admin@rc10.test', 'rc.10 admin');
INSERT INTO "nodes" ("id", "hostname", "slug", "type") VALUES
	('00000000-0000-4000-8000-000000000011', 'docker-1', 'docker-1', 'docker'),
	('00000000-0000-4000-8000-000000000012', 'docker-2', 'docker-2', 'docker');

-- Blue/green deployments: "api" routes 8080 like "web".
INSERT INTO "docker_deployments" ("id", "node_id", "name", "desired_config", "router_name", "network_name", "health_config", "status", "created_at") VALUES
	('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000011', 'web', '{"image":"nginx"}', 'gwdep-web-router', 'gwdep-web-net', '{}', 'ready', '2026-01-01T00:00:00Z'),
	('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000011', 'api', '{"image":"nginx"}', 'gwdep-api-router', 'gwdep-api-net', '{}', 'stopped', '2026-01-01T00:01:00Z');
INSERT INTO "docker_deployment_routes" ("deployment_id", "host_port", "container_port", "is_primary") VALUES
	('00000000-0000-4000-8000-000000000101', 8080, 80, true),
	('00000000-0000-4000-8000-000000000101', 8081, 81, false),
	('00000000-0000-4000-8000-000000000102', 8080, 80, true);

-- Managed storage: three active clusters named "artifacts"/"artifacts-2" and a deleting one.
INSERT INTO "object_storage_connections" ("id", "name", "slug", "provider", "encrypted_config", "created_by_id") VALUES
	('00000000-0000-4000-8000-000000000301', 'artifacts', 'artifacts-connection', 'seaweedfs', 'x', '00000000-0000-4000-8000-000000000002'),
	('00000000-0000-4000-8000-000000000702', 'backups', 'backups', 'aws', 'x', '00000000-0000-4000-8000-000000000002');
INSERT INTO "managed_storage_clusters" ("id", "node_id", "name", "slug", "version", "image_ref", "encrypted_root_credentials", "storage_size_bytes", "published_port", "publish_s3", "status", "object_storage_connection_id", "created_by_id", "created_at") VALUES
	('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000011', 'artifacts', 'artifacts', '4.47', 'img', 'x', 1, 9000, true, 'ready', NULL, '00000000-0000-4000-8000-000000000002', '2026-01-01T00:02:00Z'),
	('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000011', 'artifacts', 'artifacts-2', '4.47', 'img', 'x', 1, 9001, true, 'ready', '00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000002', '2026-01-01T00:03:00Z'),
	('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000011', 'artifacts-2', 'artifacts-2b', '4.47', 'img', 'x', 1, 9002, true, 'ready', NULL, '00000000-0000-4000-8000-000000000002', '2026-01-01T00:04:00Z'),
	('00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000011', 'artifacts', 'artifacts-old', '4.47', 'img', 'x', 1, 9003, true, 'deleting', NULL, '00000000-0000-4000-8000-000000000002', '2026-01-01T00:05:00Z');

-- Managed databases: "orders" was given the storage cluster's S3 port; "cache" publishes on node 2.
INSERT INTO "managed_database_instances" ("id", "node_id", "name", "slug", "type", "version", "image_ref", "engine_config", "encrypted_owner_credentials", "storage_size_bytes", "published_port", "status", "created_by_id", "created_at") VALUES
	('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000011', 'orders', 'orders', 'postgres', '17', 'img', '{"publishTcp":true}', 'x', 1, 9000, 'ready', '00000000-0000-4000-8000-000000000002', '2026-01-01T00:06:00Z'),
	('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000011', 'events', 'events', 'postgres', '17', 'img', '{"publishTcp":false}', 'x', 1, NULL, 'ready', '00000000-0000-4000-8000-000000000002', '2026-01-01T00:07:00Z'),
	('00000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-000000000012', 'cache', 'cache', 'redis', '8', 'img', '{"publishTcp":true}', 'x', 1, 8081, 'ready', '00000000-0000-4000-8000-000000000002', '2026-01-01T00:08:00Z');

-- Availability: "web" fails over to node 2, where its replica would bind 8080 and 8081 ("cache" holds 8081 there).
INSERT INTO "docker_availability_policies" ("id", "resource_kind", "deployment_id", "mode", "desired_replica_count") VALUES
	('00000000-0000-4000-8000-000000001001', 'deployment', '00000000-0000-4000-8000-000000000101', 'failover', 1);
INSERT INTO "docker_availability_placements" ("id", "policy_id", "node_id", "generation", "spec_fingerprint", "created_at") VALUES
	('00000000-0000-4000-8000-000000001101', '00000000-0000-4000-8000-000000001001', '00000000-0000-4000-8000-000000000011', 1, 'spec', '2026-01-01T00:09:00Z'),
	('00000000-0000-4000-8000-000000001102', '00000000-0000-4000-8000-000000001001', '00000000-0000-4000-8000-000000000012', 1, 'spec', '2026-01-01T00:10:00Z');

-- Proxy hosts: two enabled hosts serve app.example.com on node 1; a disabled one and one on node 2 do not collide.
INSERT INTO "ssl_certificates" ("id", "name", "type", "created_by_id") VALUES
	('00000000-0000-4000-8000-000000000601', 'app', 'upload', '00000000-0000-4000-8000-000000000002');
INSERT INTO "proxy_hosts" ("id", "node_id", "domain_names", "slug", "enabled", "ssl_certificate_id", "created_by_id", "created_at") VALUES
	('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000011', '["App.example.com","www.example.com"]', 'app', true, '00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000002', '2026-01-01T00:00:00Z'),
	('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000011', '[" app.example.com "]', 'app-2', true, NULL, '00000000-0000-4000-8000-000000000002', '2026-01-01T00:01:00Z'),
	('00000000-0000-4000-8000-000000000503', '00000000-0000-4000-8000-000000000011', '["app.example.com"]', 'app-3', false, NULL, '00000000-0000-4000-8000-000000000002', '2026-01-01T00:02:00Z'),
	('00000000-0000-4000-8000-000000000504', '00000000-0000-4000-8000-000000000012', '["app.example.com"]', 'app-4', true, NULL, '00000000-0000-4000-8000-000000000002', '2026-01-01T00:03:00Z');

-- Backups: three active runs of one policy (the older one running, with the executor lease) and two active restores
-- into one new database.
INSERT INTO "database_connections" ("id", "name", "slug", "type", "host", "port", "encrypted_config", "created_by_id") VALUES
	('00000000-0000-4000-8000-000000000701', 'orders', 'orders-connection', 'postgres', 'db', 5432, 'x', '00000000-0000-4000-8000-000000000002');
INSERT INTO "backup_policies" ("id", "database_connection_id", "destination_id", "bucket", "prefix", "executor_node_id", "limits") VALUES
	('00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000702', 'b', 'p', '00000000-0000-4000-8000-000000000011', '{}');
INSERT INTO "backup_runs" ("id", "policy_id", "database_connection_id", "destination_id", "destination_bucket", "destination_prefix", "timezone", "executor_node_id", "direction", "engine", "status", "request_fingerprint", "restore_target", "created_at") VALUES
	('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000702', 'b', 'p', 'UTC', '00000000-0000-4000-8000-000000000011', 'backup', 'postgres', 'queued', 'f1', NULL, '2026-01-01T00:00:00Z'),
	('00000000-0000-4000-8000-000000000902', '00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000702', 'b', 'p', 'UTC', '00000000-0000-4000-8000-000000000011', 'backup', 'postgres', 'running', 'f2', NULL, '2026-01-01T00:01:00Z'),
	('00000000-0000-4000-8000-000000000903', '00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000702', 'b', 'p', 'UTC', '00000000-0000-4000-8000-000000000011', 'backup', 'postgres', 'queued', 'f3', NULL, '2026-01-01T00:02:00Z'),
	('00000000-0000-4000-8000-000000000911', NULL, '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000702', 'b', 'p', 'UTC', '00000000-0000-4000-8000-000000000011', 'restore', 'postgres', 'queued', 'f4', '{"newManagedDatabaseName":"orders-copy"}', '2026-01-01T00:00:00Z'),
	('00000000-0000-4000-8000-000000000912', NULL, '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000702', 'b', 'p', 'UTC', '00000000-0000-4000-8000-000000000011', 'restore', 'postgres', 'running', 'f5', '{"newManagedDatabaseName":"orders-copy"}', '2026-01-01T00:01:00Z');
INSERT INTO "backup_run_node_leases" ("executor_node_id", "run_id", "expires_at") VALUES
	('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000902', '2030-01-01T00:00:00Z');

-- A settings-row lease as the rc.11 pre-release kept them (0208 drops them), next to an ordinary setting.
INSERT INTO "settings" ("key", "value") VALUES
	('operation-lease:acme:cert:00000000-0000-4000-8000-000000000601', '{"token":"t","process":"p","expiresAt":"2026-01-01T00:00:00Z","data":{}}'),
	('rc10-upgrade-setting', '{"kept":true}');
