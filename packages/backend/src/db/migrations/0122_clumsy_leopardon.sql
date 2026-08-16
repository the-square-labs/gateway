ALTER TABLE "domains" ADD COLUMN "nginx_node_id" uuid;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "pending_dns_target_ip" varchar(45);--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_nginx_node_id_nodes_id_fk" FOREIGN KEY ("nginx_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_nginx_node_idx" ON "domains" USING btree ("nginx_node_id");