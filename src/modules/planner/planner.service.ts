import type { Claim } from '@prisma/client';
import { prisma } from '@/db/prisma';
import { badRequest, notFound } from '@/common/errors';
import { completeJson } from '@/llm/router';
import { planPrompt } from '@/llm/prompts/plan';
import { resumeRepository } from '@/modules/resume/resume.repository';
import { claimRepository } from '@/modules/intelligence/claim.repository';
import { extractedResumeSchema } from '@/modules/intelligence/schema';
import { blueprintRepository } from '@/modules/planner/blueprint.repository';
import {
  planLlmSchema,
  SECTION_KEYS,
  SECTION_TITLES,
  SECTION_WEIGHTS,
  type BlueprintConfig,
  type PlanSection,
  type SectionKey,
} from '@/modules/planner/schema';

const MIN_PROBES = 3;
const MAX_PROBES = 8;

/** Rough seconds per question+answer exchange in a live interview. */
export const AVG_TURN_SECONDS = 45;
/** Opening question + ~1.5 follow-ups on average (engine caps follow-ups at 2). */
export const TURNS_PER_CLAIM = 2.5;

/**
 * How many claims the claim-verification section can honestly cover.
 * Promising 8 claims in a 15-minute interview is a promise we can't keep, and
 * unprobed claims poison the final report — so the plan is sized to the clock.
 */
export function claimCapacity(claimBudgetMin: number): number {
  const turns = (claimBudgetMin * 60) / AVG_TURN_SECONDS;
  const n = Math.floor(turns / TURNS_PER_CLAIM);
  return Math.max(MIN_PROBES, Math.min(MAX_PROBES, n));
}

/** Generate + validate an interview blueprint for a resume the user owns. */
export async function buildBlueprint(userId: string, config: BlueprintConfig) {
  const resume = await resumeRepository.findById(config.resumeId, userId);
  if (!resume) throw notFound('Resume not found');
  if (resume.parseStatus !== 'done') throw badRequest('Resume is still being analyzed', 'resume_not_ready');

  const claims = await claimRepository.listByResume(resume.id);
  if (claims.length === 0) throw badRequest('No claims to build an interview from', 'no_claims');

  // Resolve optional JD (drop a stale/foreign id rather than failing the whole plan).
  let jdId = config.jdId ?? null;
  let jdSkills: string[] = [];
  if (jdId) {
    const jd = await prisma.jobDescription.findFirst({ where: { id: jdId, userId } });
    if (jd) jdSkills = (jd.requiredSkills as string[]) ?? [];
    else jdId = null;
  }

  // flash spends output tokens on reasoning before the JSON — budget generously.
  // Projects (with origin/org) give the planner richer grounding than claims alone.
  const parsedResume = extractedResumeSchema.safeParse(resume.extracted);
  const projects = parsedResume.success ? parsedResume.data.projects : [];

  // Tell the planner up front how many claims actually fit, so it picks the BEST n
  // rather than us truncating its ranked list afterwards.
  const targetClaims = claimCapacity(config.durationMin * SECTION_WEIGHTS.claim_verification);

  // gemini-2.5-flash spends hidden "thinking" tokens before the JSON, and that scales
  // with prompt size — budget high up front so we don't waste a truncated first call.
  const { data: plan } = await completeJson(
    'plan',
    planLlmSchema,
    planPrompt(claims, jdSkills, config, projects, targetClaims),
    { maxTokens: 8192 },
  );

  const sections = normalizeSections(plan.sections, config.durationMin);
  // Re-derive from the FINAL budget — the planner may have shifted section time.
  const capacity = claimCapacity(
    sections.find((s) => s.key === 'claim_verification')?.budgetMin ?? 0,
  );
  const probeClaimIds = selectClaims(plan.probeClaimIds, claims, jdSkills, capacity);

  return blueprintRepository.create({
    userId,
    resumeId: resume.id,
    jdId,
    role: config.role,
    level: config.level,
    difficulty: config.difficulty,
    durationMin: config.durationMin,
    sections,
    probeClaimIds,
  });
}

/**
 * Force the LLM's section budgets into a sane shape:
 * canonical order, whole minutes ≥1, summing exactly to the duration.
 */
export function normalizeSections(
  llm: { key: string; budgetMin: number }[],
  duration: number,
): PlanSection[] {
  const given = new Map<SectionKey, number>();
  for (const s of llm) {
    if ((SECTION_KEYS as readonly string[]).includes(s.key) && s.budgetMin > 0) {
      given.set(s.key as SectionKey, s.budgetMin);
    }
  }

  const raw = SECTION_KEYS.map((key) => ({
    key,
    budgetMin: given.get(key) ?? SECTION_WEIGHTS[key] * duration,
  }));

  const total = raw.reduce((a, s) => a + s.budgetMin, 0) || 1;
  const scaled: PlanSection[] = raw.map((s) => ({
    key: s.key,
    title: SECTION_TITLES[s.key],
    budgetMin: Math.max(1, Math.round((s.budgetMin / total) * duration)),
  }));

  // Absorb rounding drift into the largest section so the sum is exact.
  const drift = duration - scaled.reduce((a, s) => a + s.budgetMin, 0);
  if (drift !== 0) {
    const largest = scaled.reduce((best, s) => (s.budgetMin > best.budgetMin ? s : best), scaled[0]!);
    largest.budgetMin = Math.max(1, largest.budgetMin + drift);
  }
  return scaled;
}

/** Keep valid LLM-chosen claim ids in order, then top up to `capacity` by our own ranking. */
export function selectClaims(
  llmIds: string[],
  claims: Claim[],
  jdSkills: string[],
  capacity: number,
): string[] {
  const byId = new Map(claims.map((c) => [c.id, c]));

  const chosen: string[] = [];
  for (const id of llmIds) {
    if (byId.has(id) && !chosen.includes(id)) chosen.push(id);
  }
  const result = chosen.slice(0, capacity);

  const target = Math.min(capacity, claims.length);
  if (result.length < target) {
    const jdLower = new Set(jdSkills.map((s) => s.toLowerCase()));
    const ranked = [...claims].sort((a, b) => score(b, jdLower) - score(a, jdLower));
    for (const c of ranked) {
      if (result.length >= target) break;
      if (!result.includes(c.id)) result.push(c.id);
    }
  }
  return result;
}

function score(c: Claim, jdLower: Set<string>): number {
  const relevance = c.relatedSkills.filter((s) => jdLower.has(s.toLowerCase())).length;
  return c.importance * c.priority + relevance * 2;
}
