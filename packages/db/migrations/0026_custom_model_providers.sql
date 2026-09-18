CREATE TABLE "custom_model_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" text NOT NULL REFERENCES identity."user"("id"),
  "organization_id" text REFERENCES identity."organization"("id") ON DELETE cascade,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "protocol" text NOT NULL,
  "base_url" text NOT NULL,
  "models" jsonb NOT NULL,
  "encrypted_api_key" text,
  "key_hint" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "custom_model_providers_protocol_check" CHECK (protocol IN ('openai', 'openai-responses', 'anthropic'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "custom_model_providers_org_slug_idx" ON "custom_model_providers" ("organization_id", "slug");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_model_providers_local_slug_idx" ON "custom_model_providers" ("slug") WHERE organization_id IS NULL;--> statement-breakpoint
ALTER TABLE "custom_model_providers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "custom_model_providers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "custom_model_providers_org_isolation" ON "custom_model_providers"
  USING (organization_id IS NOT DISTINCT FROM bento_current_org())
  WITH CHECK (organization_id IS NOT DISTINCT FROM bento_current_org());--> statement-breakpoint
-- This is an organization-level root row, with no UUID parent for
-- bento_inherit_org. Derive its scope from the tenant transaction when
-- the route omits it, as the child-table inherit triggers do from parents.
CREATE FUNCTION bento_custom_provider_org() RETURNS trigger AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := bento_current_org();
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER custom_model_providers_inherit_org BEFORE INSERT ON custom_model_providers
  FOR EACH ROW EXECUTE FUNCTION bento_custom_provider_org();
