-- Whether the board's two mascots come out on a quiet board for this
-- person. On for everybody: dismissing them on the board turns it off,
-- and Settings, Account turns it back on.
ALTER TABLE "identity"."user" ADD COLUMN "board_mascots" boolean DEFAULT true NOT NULL;
