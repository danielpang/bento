-- A plan source that is a PDF or an image.
--
-- The text column becomes optional, and two columns say where the
-- bytes are: a key in the artifact store, minted by the server, and
-- their size. A key rather than a URL, because the bucket is private
-- and the row is the authority on who may read it; the server fetches
-- by key after the row's access check, the way run_artifacts works.
-- A source still has to be something a planner could read, so a row
-- holds text, bytes, or both, and never neither.
ALTER TABLE "swarm_plan_sources" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "swarm_plan_sources" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "swarm_plan_sources" ADD COLUMN "byte_size" integer;--> statement-breakpoint
ALTER TABLE "swarm_plan_sources" ADD CONSTRAINT "swarm_plan_sources_content_or_key" CHECK ("content" is not null or "storage_key" is not null);
