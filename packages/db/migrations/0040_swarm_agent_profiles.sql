ALTER TABLE "swarms" ADD COLUMN "planner_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "swarms" ADD COLUMN "worker_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_planner_profile_id_agent_profiles_id_fk" FOREIGN KEY ("planner_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_worker_profile_id_agent_profiles_id_fk" FOREIGN KEY ("worker_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE set null ON UPDATE no action;