DROP INDEX "mcp_servers_org_slug_idx";--> statement-breakpoint
DROP INDEX "mcp_servers_local_slug_idx";--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_org_user_slug_idx" ON "mcp_servers" USING btree ("organization_id","user_id","slug") WHERE "mcp_servers"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_local_user_slug_idx" ON "mcp_servers" USING btree ("user_id","slug") WHERE "mcp_servers"."organization_id" is null and "mcp_servers"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_org_slug_idx" ON "mcp_servers" USING btree ("organization_id","slug") WHERE "mcp_servers"."user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_local_slug_idx" ON "mcp_servers" USING btree ("slug") WHERE "mcp_servers"."organization_id" is null and "mcp_servers"."user_id" is null;