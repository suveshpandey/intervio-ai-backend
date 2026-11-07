import { prisma } from '@/db/prisma';
import type { ClaimBand } from '@/modules/report/scoring';

/** How a claim fared each time it was actually asked about, oldest first. */
export type ClaimAttempts = Exclude<ClaimBand, 'not_covered'>[];

/**
 * Every past outcome per claim for one resume, read from the saved reports.
 * A claim that was planned but never reached ("not covered") is not an attempt.
 */
export async function claimHistory(
  userId: string,
  resumeId: string,
): Promise<Map<string, ClaimAttempts>> {
  const reports = await prisma.report.findMany({
    where: { interview: { userId, blueprint: { resumeId } } },
    orderBy: { interview: { createdAt: 'asc' } },
    select: { claimAudit: true },
  });

  const history = new Map<string, ClaimAttempts>();
  for (const { claimAudit } of reports) {
    for (const entry of (claimAudit ?? []) as { claimId: string; band: ClaimBand }[]) {
      if (entry.band === 'not_covered') continue;
      const list = history.get(entry.claimId) ?? [];
      list.push(entry.band);
      history.set(entry.claimId, list);
    }
  }
  return history;
}
