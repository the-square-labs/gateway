-- Route Secure Link over loopback TCP (2.11.4): every link gets its own loopback address on the nginx nodes that source
-- it (127.64.0.0 onwards, one port for all), derived from a slot unique across both link tables. Existing links get
-- theirs here (the default fills every row with its own value), new ones on insert.
CREATE SEQUENCE IF NOT EXISTS "secure_link_loopback_slot_seq" AS integer START WITH 1 MINVALUE 1 MAXVALUE 12000000 NO CYCLE;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "secure_link_loopback_slot" integer DEFAULT nextval('secure_link_loopback_slot_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD COLUMN "loopback_slot" integer DEFAULT nextval('secure_link_loopback_slot_seq') NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "proxy_hosts_secure_link_loopback_slot_unique" ON "proxy_hosts" USING btree ("secure_link_loopback_slot");--> statement-breakpoint
CREATE UNIQUE INDEX "proxy_additional_secure_links_loopback_slot_unique" ON "proxy_additional_secure_links" USING btree ("loopback_slot");
