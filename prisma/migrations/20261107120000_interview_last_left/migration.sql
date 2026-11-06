-- When an interview's voice connection last dropped, so a candidate can rejoin for a short while.
ALTER TABLE "interviews" ADD COLUMN "last_left_at" TIMESTAMP(3);
