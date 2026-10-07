-- Every project is on "auto". The setting is no longer something a
-- person picks: the console card and the API that set it are gone,
-- and a project pinned to one provider by a beta tester moves to the
-- same order as everyone else. The column stays so an operator can
-- still pin a project by hand in an emergency, without a deploy.
UPDATE projects SET sandbox_provider = 'auto' WHERE sandbox_provider IS DISTINCT FROM 'auto';
