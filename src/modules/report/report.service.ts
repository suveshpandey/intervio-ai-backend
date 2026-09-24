/**
 * Builds and stores the report for a finished interview.
 *
 * Reads only Postgres (turns + evidence + the blueprint's planned claims), so a
 * report can be built long after the interview — the live Redis state is gone by
 * then, and after an early end it is cleared deliberately.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/db/prisma';
import { badRequest, notFound } from '@/common/errors';
import { logger } from '@/common/logger';
import { interviewRepository } from '@/modules/interview/interview.repository';
import { writeNarrative } from '@/modules/report/narrative';
import {
  computeReport,
  MIN_ANSWERS_FOR_REPORT,
  type ComputedReport,
  type PlannedClaim,
  type ReportEvidence,
  type ReportTurn,
} from '@/modules/report/scoring';
import type { EvalResult } from '@/modules/interview/types';

export interface ReportView extends ComputedReport {
  interviewId: string;
  role: string;
  level: string;
  /** True when the interview was ended early — the report covers only what was asked. */
  partial: boolean;
  narrative: string;
  generatedAt: Date;
}

/** The stored report, building it first if it doesn't exist yet. */
export async function getOrCreateReport(userId: string, interviewId: string): Promise<ReportView> {
  const existing = await prisma.report.findUnique({ where: { interviewId } });
  if (existing) {
    const interview = await interviewRepository.findById(interviewId, userId);
    if (!interview) throw notFound('Interview not found');
    return toView(existing, interview.blueprint.role, interview.blueprint.level, interview.status);
  }
  return generateReport(userId, interviewId);
}

/** Computes, writes the narrative, and saves. Overwrites any existing report. */
export async function generateReport(userId: string, interviewId: string): Promise<ReportView> {
  const interview = await interviewRepository.findById(interviewId, userId);
  if (!interview) throw notFound('Interview not found');
  if (interview.status === 'live' || interview.status === 'planned') {
    throw badRequest('This interview is not finished yet', 'interview_not_finished');
  }

  const { turns, evidence, claims } = await loadInputs(interviewId, interview.blueprint.probeClaimIds);
  const answered = turns.filter((t) => t.answer.trim().length > 0);
  if (answered.length < MIN_ANSWERS_FOR_REPORT) {
    throw badRequest(
      `This interview was too short to report on — ${answered.length} of ${MIN_ANSWERS_FOR_REPORT} answers needed.`,
      'interview_too_short',
    );
  }

  const computed = computeReport(turns, evidence, claims);
  const { text, source } = await writeNarrative(computed, interview.blueprint.role, interview.blueprint.level);

  // Our own typed structures; Prisma wants them as plain JSON.
  const json = (value: unknown) => value as Prisma.InputJsonValue;
  const data = {
    verdict: computed.readiness.verdict,
    stats: json(computed.stats),
    skillScores: json(computed.skills),
    dimensions: json(computed.dimensions),
    claimAudit: json(computed.claimAudit),
    readiness: json(computed.readiness),
    improvements: json(computed.improvements),
    narrative: text,
    narrativeSource: source,
  };

  const saved = await prisma.report.upsert({
    where: { interviewId },
    create: { interviewId, ...data },
    update: data,
  });

  logger.info(
    {
      interviewId,
      verdict: computed.readiness.verdict,
      claims: `${computed.stats.claimsSupported}/${computed.stats.claimsProbed}`,
      narrative: source,
    },
    'report generated',
  );

  return toView(saved, interview.blueprint.role, interview.blueprint.level, interview.status);
}

/** Turns + evidence + the claims the plan intended to probe, in plan order. */
async function loadInputs(interviewId: string, probeClaimIds: string[]) {
  const [turnRows, evidenceRows, claimRows] = await Promise.all([
    interviewRepository.listTurns(interviewId),
    prisma.evidence.findMany({ where: { interviewId } }),
    prisma.claim.findMany({ where: { id: { in: probeClaimIds } }, select: { id: true, text: true } }),
  ]);

  const turns: ReportTurn[] = turnRows.map((t) => ({
    id: t.id,
    idx: t.idx,
    claimId: t.claimId,
    question: t.questionText,
    answer: t.answerTranscript ?? '',
    eval: (t.eval ?? {}) as unknown as EvalResult,
  }));

  const evidence: ReportEvidence[] = evidenceRows.map((e) => ({
    claimId: e.claimId,
    turnId: e.turnId,
    polarity: e.polarity === 'weaken' ? 'weaken' : 'support',
    rationale: e.rationale,
  }));

  // Plan order, not database order — the report should read like the interview ran.
  const byId = new Map(claimRows.map((c) => [c.id, c.text]));
  const claims: PlannedClaim[] = probeClaimIds
    .filter((id) => byId.has(id))
    .map((id) => ({ id, text: byId.get(id)! }));

  return { turns, evidence, claims };
}

function toView(
  row: {
    interviewId: string;
    stats: unknown;
    skillScores: unknown;
    dimensions: unknown;
    claimAudit: unknown;
    readiness: unknown;
    improvements: unknown;
    narrative: string;
    createdAt: Date;
  },
  role: string,
  level: string,
  status: string,
): ReportView {
  return {
    interviewId: row.interviewId,
    role,
    level,
    partial: status === 'abandoned',
    stats: row.stats as ReportView['stats'],
    skills: row.skillScores as ReportView['skills'],
    dimensions: row.dimensions as ReportView['dimensions'],
    claimAudit: row.claimAudit as ReportView['claimAudit'],
    readiness: row.readiness as ReportView['readiness'],
    improvements: row.improvements as ReportView['improvements'],
    narrative: row.narrative,
    generatedAt: row.createdAt,
  };
}

/** Do we have enough to report on? Used by the queue so it doesn't retry pointlessly. */
export async function hasEnoughAnswers(interviewId: string): Promise<boolean> {
  const answered = await prisma.turn.count({
    where: { interviewId, answerTranscript: { not: null } },
  });
  return answered >= MIN_ANSWERS_FOR_REPORT;
}
