ALTER TYPE "public"."database_binding_target_type" ADD VALUE 'compose_service';--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD COLUMN "docker_compose_project_id" uuid;--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD COLUMN "docker_compose_service_name" varchar(255);--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD COLUMN "docker_compose_project_id" uuid;--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD COLUMN "docker_compose_service_name" varchar(255);--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "docker_compose_project_id" uuid;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "docker_compose_service_name" varchar(255);--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_docker_compose_project_id_docker_compose_projects_id_fk" FOREIGN KEY ("docker_compose_project_id") REFERENCES "public"."docker_compose_projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD CONSTRAINT "proxy_additional_secure_links_docker_compose_project_id_docker_compose_projects_id_fk" FOREIGN KEY ("docker_compose_project_id") REFERENCES "public"."docker_compose_projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD CONSTRAINT "proxy_hosts_docker_compose_project_id_docker_compose_projects_id_fk" FOREIGN KEY ("docker_compose_project_id") REFERENCES "public"."docker_compose_projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proxy_additional_routes_docker_compose_project_idx" ON "proxy_additional_routes" USING btree ("docker_compose_project_id");--> statement-breakpoint
CREATE INDEX "proxy_additional_secure_links_docker_compose_project_idx" ON "proxy_additional_secure_links" USING btree ("docker_compose_project_id");--> statement-breakpoint
CREATE INDEX "proxy_host_docker_compose_project_idx" ON "proxy_hosts" USING btree ("docker_compose_project_id");