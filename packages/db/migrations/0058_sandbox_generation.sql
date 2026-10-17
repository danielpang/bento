ALTER TABLE sandboxes ADD COLUMN generation integer NOT NULL DEFAULT 1;
-- A restored or replaced incarnation invalidates delayed lifecycle work.
CREATE FUNCTION bento_sandbox_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.provider IS DISTINCT FROM OLD.provider
    OR (OLD.status IN ('destroyed','hibernated') AND NEW.status IN ('ready','busy','provisioning')) THEN
   NEW.generation := OLD.generation + 1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sandbox_generation BEFORE UPDATE ON sandboxes
 FOR EACH ROW EXECUTE FUNCTION bento_sandbox_generation();
