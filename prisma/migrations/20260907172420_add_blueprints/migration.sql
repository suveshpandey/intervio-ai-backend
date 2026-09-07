-- CreateTable
CREATE TABLE "blueprints" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "resume_id" TEXT NOT NULL,
    "jd_id" TEXT,
    "role" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "sections" JSONB NOT NULL,
    "probe_claim_ids" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blueprints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blueprints_user_id_idx" ON "blueprints"("user_id");

-- CreateIndex
CREATE INDEX "blueprints_resume_id_idx" ON "blueprints"("resume_id");

-- AddForeignKey
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
