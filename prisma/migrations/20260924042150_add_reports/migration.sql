-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "interview_id" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "stats" JSONB NOT NULL,
    "skill_scores" JSONB NOT NULL,
    "dimensions" JSONB NOT NULL,
    "claim_audit" JSONB NOT NULL,
    "readiness" JSONB NOT NULL,
    "improvements" JSONB NOT NULL,
    "narrative" TEXT NOT NULL,
    "narrative_source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reports_interview_id_key" ON "reports"("interview_id");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
