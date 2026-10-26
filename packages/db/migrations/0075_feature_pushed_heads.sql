ALTER TABLE features ADD COLUMN pushed_heads jsonb NOT NULL DEFAULT '{}'::jsonb;
