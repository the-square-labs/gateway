\set ON_ERROR_STOP on

INSERT INTO node_folders (id, name, created_by_id)
VALUES ('10000000-0000-4000-8000-000000000001', 'release-e2e-nodes', '00000000-0000-0000-0000-000000000000');

INSERT INTO nodes (
  id, type, hostname, display_name, status, slug, service_address, last_health_report, folder_id
)
VALUES
  (
    '11000000-0000-4000-8000-000000000001', 'nginx', 'release-nginx-1', 'Release Nginx 1', 'offline',
    'release-nginx-1', '8.8.8.8',
    '{"publicIpAddresses":["8.8.8.8"],"localIpAddresses":["10.0.0.11"]}'::jsonb,
    '10000000-0000-4000-8000-000000000001'
  ),
  (
    '11000000-0000-4000-8000-000000000002', 'nginx', 'release-nginx-2', 'Release Nginx 2', 'offline',
    'release-nginx-2', '1.1.1.1',
    '{"publicIpAddresses":["1.1.1.1"],"localIpAddresses":["10.0.0.12"]}'::jsonb,
    '10000000-0000-4000-8000-000000000001'
  ),
  (
    '11000000-0000-4000-8000-000000000003', 'docker', 'release-docker-1', 'Release Docker 1', 'offline',
    'release-docker-1', '10.0.0.13',
    '{"publicIpAddresses":["9.9.9.9"],"localIpAddresses":["10.0.0.13"]}'::jsonb,
    '10000000-0000-4000-8000-000000000001'
  );

INSERT INTO domain_folders (id, name, created_by_id)
VALUES ('12000000-0000-4000-8000-000000000001', 'release-e2e-domains', '00000000-0000-0000-0000-000000000000');

INSERT INTO proxy_host_folders (id, name, created_by_id)
VALUES ('13000000-0000-4000-8000-000000000001', 'release-e2e-proxies', '00000000-0000-0000-0000-000000000000');

INSERT INTO domains (
  id, domain, description, dns_status, dns_records, created_by_id, folder_id,
  dns_provider, dns_ownership, dns_target_ips, dns_record_type
)
VALUES
  (
    '14000000-0000-4000-8000-000000000001', 'legacy.example.test', 'release-e2e-domain', 'valid',
    '{"a":["8.8.8.8"],"aaaa":[],"cname":[],"caa":[],"mx":[],"txt":[]}'::jsonb,
    '00000000-0000-0000-0000-000000000000', '12000000-0000-4000-8000-000000000001',
    'legacy', 'legacy', '["8.8.8.8"]'::jsonb, 'A'
  ),
  (
    '14000000-0000-4000-8000-000000000002', '*.wildcard.example.test', 'release-e2e-wildcard', 'valid',
    '{"a":["1.1.1.1"],"aaaa":[],"cname":[],"caa":[],"mx":[],"txt":[]}'::jsonb,
    '00000000-0000-0000-0000-000000000000', '12000000-0000-4000-8000-000000000001',
    'legacy', 'legacy', '["1.1.1.1"]'::jsonb, 'A'
  );

INSERT INTO proxy_hosts (
  id, domain_names, enabled, forward_host, forward_port, forward_scheme,
  folder_id, node_id, created_by_id, slug, upstream_kind
)
VALUES (
  '15000000-0000-4000-8000-000000000001', '["legacy.example.test"]'::jsonb, true,
  '127.0.0.1', 8080, 'http', '13000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'release-e2e-proxy', 'manual'
);

INSERT INTO docker_container_folders (id, name, node_id, created_by_id, resource_type)
VALUES (
  '16000000-0000-4000-8000-000000000001', 'release-e2e-containers',
  '11000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'container'
);

INSERT INTO docker_container_folder_assignments (
  id, node_id, container_name, folder_id, resource_type, resource_key
)
VALUES (
  '17000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
  'release-e2e-workload', '16000000-0000-4000-8000-000000000001', 'container', 'release-e2e-workload'
);

INSERT INTO integration_connectors (
  id, provider, name, base_url, enabled, allowlist_mode, settings, capabilities, sync_status
)
VALUES (
  '18000000-0000-4000-8000-000000000001', 'gitlab', 'release-e2e-gitlab',
  'https://gitlab.example.test', false, 'selected', '{}'::jsonb, '{}'::jsonb, 'never'
);

INSERT INTO settings (key, value)
VALUES ('release:e2e:sentinel', '{"value":"v2.6.12"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
