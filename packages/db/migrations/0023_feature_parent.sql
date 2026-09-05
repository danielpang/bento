ALTER TABLE "features" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_parent_id_features_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."features"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "features_parent_idx" ON "features" USING btree ("parent_id");
