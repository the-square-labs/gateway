-- A managed storage link of an Availability workload runs on every placement node: one relay route per source node,
-- like a proxy Secure Link served by an ingress group. Every other owner keeps one route.
DROP INDEX "relay_routes_owner_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "relay_routes_storage_link_source_unique" ON "relay_routes" USING btree ("owner_kind","owner_id","source_kind","source_id") WHERE "relay_routes"."owner_kind" = 'managed_storage_binding';--> statement-breakpoint
CREATE UNIQUE INDEX "relay_routes_owner_unique" ON "relay_routes" USING btree ("owner_kind","owner_id") WHERE "relay_routes"."owner_kind" not in ('proxy_host_secure_link', 'managed_storage_binding');