-- The interview target (role, level, difficulty, duration, voice, JD) is saved once per resume.
ALTER TABLE "resumes" ADD COLUMN "target" JSONB;
