-- One resume can be used for several roles, so the saved target becomes a list (one per role).
-- The earlier single-object value is dropped; it is rebuilt from defaults on next use.
ALTER TABLE "resumes" RENAME COLUMN "target" TO "targets";
UPDATE "resumes" SET "targets" = NULL;
