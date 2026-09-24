/**
 * The report's numbers (PRD §12 Phase 5). PURE — no DB, no LLM, no clock.
 *
 * Every figure a user sees is computed here from saved turns and evidence. The
 * LLM only writes prose around these numbers later; it never produces one.
 * Recomputable at any time, which also means a report can be rebuilt after a
 * scoring fix without re-running the interview.
 */

import { CONFIDENCE_DELTA, verdictFor } from '@/modules/interview/engine/rules';
import { normalizeSkill } from '@/modules/interview/engine/orchestrator';
import type { EvalResult } from '@/modules/interview/types';

/** Below this many answered turns there isn't enough signal to report on (user's call). */
export const MIN_ANSWERS_FOR_REPORT = 3;

/** A skill needs this many scored answers before it counts toward readiness. */
const MIN_SAMPLES_FOR_READINESS = 2;

/** Readiness thresholds — deliberately visible constants, not magic in a function. */
const READY = { supportedShare: 0.6, depth: 6, quality: 6 };
const ALMOST = { supportedShare: 0.35, depth: 4.5, quality: 4.5 };
/** Skills at or below this are called out as gaps. */
const WEAK_SKILL_SCORE = 5;

export interface ReportTurn {
  id: string;
  idx: number;
  claimId: string | null;
  question: string;
  answer: string;
  eval: EvalResult;
}

export interface ReportEvidence {
  claimId: string;
  turnId: string;
  polarity: 'support' | 'weaken';
  rationale: string;
}

export interface PlannedClaim {
  id: string;
  text: string;
}

export interface SkillScore {
  skill: string;
  /** 0–10. */
  score: number;
  /** How many answers it's based on — a 9 from one answer is not a 9 from five. */
  samples: number;
}

export interface Dimension {
  key: 'depth' | 'quality' | 'specificity';
  label: string;
  score: number;
  detail: string;
}

/** PRD §"safe language": evidence bands, never accusations. */
export type ClaimBand = 'supported' | 'partial' | 'insufficient' | 'not_covered';

export interface ClaimAuditEntry {
  claimId: string;
  text: string;
  band: ClaimBand;
  /** 0–1, computed from the same deltas the live engine used. */
  confidence: number;
  turnsSpent: number;
  evidence: { turnIdx: number; polarity: 'support' | 'weaken'; rationale: string; quote: string }[];
}

export type Verdict = 'ready' | 'almost' | 'not_ready';

export interface Readiness {
  verdict: Verdict;
  /** Plain-language reasons the verdict came out this way. */
  reasons: string[];
  /** Named things to fix — never a bare score. */
  gaps: string[];
}

export interface Improvement {
  title: string;
  detail: string;
}

export interface ComputedReport {
  stats: {
    answeredTurns: number;
    claimsProbed: number;
    claimsSupported: number;
    claimsNotCovered: number;
  };
  skills: SkillScore[];
  dimensions: Dimension[];
  claimAudit: ClaimAuditEntry[];
  readiness: Readiness;
  improvements: Improvement[];
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const to10 = (unit: number) => Math.round(clamp01(unit) * 100) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function computeReport(
  turns: ReportTurn[],
  evidence: ReportEvidence[],
  plannedClaims: PlannedClaim[],
): ComputedReport {
  const answered = turns.filter((t) => t.answer.trim().length > 0);
  const skills = skillScores(answered);
  const dimensions = dimensionScores(answered);
  const claimAudit = auditClaims(answered, evidence, plannedClaims);
  const readiness = assessReadiness(claimAudit, dimensions, skills);
  const improvements = suggestImprovements(claimAudit, dimensions, skills, answered);

  const probed = claimAudit.filter((c) => c.band !== 'not_covered');
  return {
    stats: {
      answeredTurns: answered.length,
      claimsProbed: probed.length,
      claimsSupported: probed.filter((c) => c.band === 'supported').length,
      claimsNotCovered: claimAudit.length - probed.length,
    },
    skills,
    dimensions,
    claimAudit,
    readiness,
    improvements,
  };
}

/** Running mean per skill across the interview, on a 0–10 scale. */
export function skillScores(answered: ReportTurn[]): SkillScore[] {
  const acc = new Map<string, { total: number; samples: number }>();
  for (const turn of answered) {
    for (const { skill, score } of turn.eval.skills) {
      const key = normalizeSkill(skill);
      if (!key) continue;
      const prev = acc.get(key) ?? { total: 0, samples: 0 };
      acc.set(key, { total: prev.total + score, samples: prev.samples + 1 });
    }
  }
  return [...acc.entries()]
    .map(([skill, { total, samples }]) => ({ skill, score: to10(total / samples), samples }))
    .sort((a, b) => b.samples - a.samples || b.score - a.score);
}

/**
 * Three things the saved evaluations can honestly support. Not invented axes:
 * each one maps to a field the interviewer actually scored per answer.
 */
export function dimensionScores(answered: ReportTurn[]): Dimension[] {
  const depth = mean(answered.map((t) => t.eval.technicalDepth));
  const quality = mean(answered.map((t) => t.eval.answerQuality));
  const vague = answered.filter((t) => t.eval.issue === 'generic' || t.eval.issue === 'memorized').length;
  const specificity = answered.length ? 1 - vague / answered.length : 0;

  return [
    {
      key: 'depth',
      label: 'Technical depth',
      score: to10(depth),
      detail: 'How far your answers went past the surface of your own work.',
    },
    {
      key: 'quality',
      label: 'Answer quality',
      score: to10(quality),
      detail: 'How well each answer actually addressed what was asked.',
    },
    {
      key: 'specificity',
      label: 'Specificity',
      score: to10(specificity),
      detail: `${answered.length - vague} of ${answered.length} answers were concrete rather than general.`,
    },
  ];
}

/**
 * Per claim: how strongly the answers actually backed it up, from the saved
 * turns (evidence rows only exist for support/weaken, so they'd miss the partial
 * credit). Evidence supplies the human-readable "why".
 *
 * Deliberately NOT the engine's running total. The engine ADDS up confidence to
 * decide when it has heard enough and can move on — so a claim settled in one
 * convincing answer never reaches its "supported" threshold, and nearly every
 * claim would be reported as partial. The report instead asks a different
 * question: of the support these answers COULD have given, how much did they?
 * Same per-answer weights, divided by the best possible over the turns spent.
 */
export function auditClaims(
  answered: ReportTurn[],
  evidence: ReportEvidence[],
  plannedClaims: PlannedClaim[],
): ClaimAuditEntry[] {
  const turnById = new Map(answered.map((t) => [t.id, t]));

  return plannedClaims.map(({ id, text }) => {
    const claimTurns = answered.filter((t) => t.claimId === id);
    const earned = claimTurns.reduce(
      (sum, t) => sum + CONFIDENCE_DELTA[t.eval.claimEvidence] * t.eval.answerQuality,
      0,
    );
    const best = claimTurns.length * CONFIDENCE_DELTA.support;
    const confidence = best > 0 ? clamp01(earned / best) : 0;

    // Never asked about — not a failure, and must not be scored as one.
    const band: ClaimBand = claimTurns.length === 0 ? 'not_covered' : bandFor(confidence, claimTurns.length);

    return {
      claimId: id,
      text,
      band,
      confidence: Math.round(confidence * 100) / 100,
      turnsSpent: claimTurns.length,
      evidence: evidence
        .filter((e) => e.claimId === id)
        .map((e) => {
          const turn = turnById.get(e.turnId);
          return {
            turnIdx: turn?.idx ?? 0,
            polarity: e.polarity,
            rationale: e.rationale,
            quote: turn?.answer ?? '',
          };
        })
        .sort((a, b) => a.turnIdx - b.turnIdx),
    };
  });
}

/** The engine's verdict wording, mapped to the PRD's report bands. */
function bandFor(confidence: number, turnsSpent: number): ClaimBand {
  const verdict = verdictFor(confidence, turnsSpent);
  return verdict === 'verified' ? 'supported' : verdict === 'partial' ? 'partial' : 'insufficient';
}

/** Rules over the computed numbers — three bands (user's call), always with reasons. */
export function assessReadiness(
  claimAudit: ClaimAuditEntry[],
  dimensions: Dimension[],
  skills: SkillScore[],
): Readiness {
  const probed = claimAudit.filter((c) => c.band !== 'not_covered');
  const supported = probed.filter((c) => c.band === 'supported').length;
  const supportedShare = probed.length ? supported / probed.length : 0;
  const depth = dimensions.find((d) => d.key === 'depth')?.score ?? 0;
  const quality = dimensions.find((d) => d.key === 'quality')?.score ?? 0;

  const verdict: Verdict =
    supportedShare >= READY.supportedShare && depth >= READY.depth && quality >= READY.quality
      ? 'ready'
      : supportedShare >= ALMOST.supportedShare && depth >= ALMOST.depth && quality >= ALMOST.quality
        ? 'almost'
        : 'not_ready';

  const reasons = [
    probed.length
      ? `You backed up ${supported} of ${probed.length} claims you were asked about.`
      : 'No resume claims were covered in this interview.',
    `Technical depth ${depth.toFixed(1)}/10 and answer quality ${quality.toFixed(1)}/10.`,
  ];

  const gaps: string[] = [];
  for (const claim of probed) {
    if (claim.band === 'insufficient') gaps.push(`Couldn't back up: ${claim.text}`);
  }
  for (const claim of probed) {
    if (claim.band === 'partial') gaps.push(`Only partly backed up: ${claim.text}`);
  }
  for (const skill of skills) {
    if (skill.samples >= MIN_SAMPLES_FOR_READINESS && skill.score <= WEAK_SKILL_SCORE) {
      gaps.push(`Weak on ${skill.skill} (${skill.score.toFixed(1)}/10 over ${skill.samples} answers).`);
    }
  }
  const notCovered = claimAudit.filter((c) => c.band === 'not_covered').length;
  if (notCovered) {
    reasons.push(`${notCovered} planned claim${notCovered > 1 ? 's were' : ' was'} not reached before time ran out.`);
  }

  return { verdict, reasons, gaps };
}

/** Top 3 concrete things to work on, worst first. */
export function suggestImprovements(
  claimAudit: ClaimAuditEntry[],
  dimensions: Dimension[],
  skills: SkillScore[],
  answered: ReportTurn[],
): Improvement[] {
  const out: Improvement[] = [];

  // At most ONE claim item, else a bad interview returns the same advice three
  // times over. The rest of the unbacked claims are already named in the gaps.
  const unbacked = claimAudit.filter((c) => c.band === 'insufficient');
  if (unbacked.length === 1) {
    out.push({
      title: 'Prepare the numbers behind this line',
      detail: `You couldn't back up "${unbacked[0]!.text}". Write down what you personally did, the before/after numbers, and how you measured them.`,
    });
  } else if (unbacked.length > 1) {
    out.push({
      title: `Rehearse the ${unbacked.length} claims you couldn't back up`,
      detail: `Starting with "${unbacked[0]!.text}". For each one, write down what you personally did, the before/after numbers, and how you measured them.`,
    });
  }

  const vague = answered.filter((t) => t.eval.issue === 'generic' || t.eval.issue === 'memorized').length;
  if (answered.length && vague / answered.length > 0.3) {
    out.push({
      title: 'Answer with specifics, not definitions',
      detail: `${vague} of ${answered.length} answers stayed general. Lead with what you did on a real project, then the outcome.`,
    });
  }

  const depth = dimensions.find((d) => d.key === 'depth')?.score ?? 10;
  if (depth < 6) {
    out.push({
      title: 'Go one level deeper',
      detail: `Technical depth came out at ${depth.toFixed(1)}/10. For each project, be ready for the follow-up: why that approach, what you rejected, what broke.`,
    });
  }

  for (const skill of skills) {
    if (skill.samples >= MIN_SAMPLES_FOR_READINESS && skill.score <= WEAK_SKILL_SCORE) {
      out.push({
        title: `Brush up on ${skill.skill}`,
        detail: `Scored ${skill.score.toFixed(1)}/10 across ${skill.samples} answers — the weakest area the interview touched.`,
      });
    }
  }

  for (const claim of claimAudit.filter((c) => c.band === 'partial')) {
    out.push({
      title: 'Finish the story on this claim',
      detail: `"${claim.text}" was only partly backed up. The detail that was missing is what an interviewer will push on.`,
    });
  }

  return out.slice(0, 3);
}
