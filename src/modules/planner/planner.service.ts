import type { Claim } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/db/prisma';
import { DEFAULT_VOICE } from '@/modules/voice/voices';
import { badRequest, notFound } from '@/common/errors';
import { resumeRepository } from '@/modules/resume/resume.repository';
import { claimRepository } from '@/modules/intelligence/claim.repository';
import { claimHistory, type ClaimAttempts } from '@/modules/planner/claim-history';
import { blueprintRepository } from '@/modules/planner/blueprint.repository';
import {
  SECTION_KEYS,
  SECTION_TITLES,
  SECTION_WEIGHTS,
  targetSchema,
  type BlueprintConfig,
  type InterviewTarget,
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
  if (resume.parseStatus !== 'done')
    throw badRequest('Resume is still being analyzed', 'resume_not_ready');

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

  // The section split is a fixed formula and the claims are picked by rule (selectClaims),
  // so building a plan is instant and two interviews on one resume are comparable.
  // (It used to ask an LLM, ~20s, and got a different answer every time.)
  const sections = normalizeSections([], config.durationMin);
  const capacity = claimCapacity(
    sections.find((s) => s.key === 'claim_verification')?.budgetMin ?? 0,
  );
  const history = await claimHistory(userId, resume.id);
  const probeClaimIds = selectClaims(claims, jdSkills, capacity, history);

  return blueprintRepository.create({
    userId,
    resumeId: resume.id,
    jdId,
    role: config.role,
    level: config.level,
    difficulty: config.difficulty,
    durationMin: config.durationMin,
    voice: config.voice,
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
    const largest = scaled.reduce(
      (best, s) => (s.budgetMin > best.budgetMin ? s : best),
      scaled[0]!,
    );
    largest.budgetMin = Math.max(1, largest.budgetMin + drift);
  }
  return scaled;
}

/**
 * 0 = failed last time (always asked again) · 1 = untested, or held up once (still
 * worth asking) · 2 = held up twice running (makes room for others).
 */
export function claimTier(attempts: ClaimAttempts = []): 0 | 1 | 2 {
  const last = attempts[attempts.length - 1];
  if (last && last !== 'supported') return 0;
  if (attempts.length >= 2 && attempts[attempts.length - 2] === 'supported') return 2;
  return 1;
}

/**
 * Pick which claims this interview probes — by rule, never by an LLM, so every
 * interview on a resume checks the same important claims and results compare.
 * Order: tier (see claimTier), then importance × priority (+ JD match), then a
 * stable tie-break so the same inputs always give the same plan.
 */
export function selectClaims(
  claims: Claim[],
  jdSkills: string[],
  capacity: number,
  history: Map<string, ClaimAttempts> = new Map(),
): string[] {
  const jdLower = new Set(jdSkills.map((s) => s.toLowerCase()));
  return [...claims]
    .sort(
      (a, b) =>
        claimTier(history.get(a.id)) - claimTier(history.get(b.id)) ||
        score(b, jdLower) - score(a, jdLower) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .slice(0, Math.min(capacity, claims.length))
    .map((c) => c.id);
}

function score(c: Claim, jdLower: Set<string>): number {
  const relevance = c.relatedSkills.filter((s) => jdLower.has(s.toLowerCase())).length;
  return c.importance * c.priority + relevance * 2;
}

/** What "Start interview" uses when the user hasn't tweaked the target yet. */
export function defaultTarget(resume: { extracted: unknown }): InterviewTarget {
  const role = (resume.extracted as { experience?: { role?: string }[] } | null)?.experience?.[0]
    ?.role;
  return {
    role: role?.trim() || 'Software Engineer',
    level: 'mid',
    difficulty: 'standard',
    durationMin: 15,
    voice: DEFAULT_VOICE,
  };
}

/** Most roles a resume remembers; the least recently used is forgotten first. */
export const MAX_TARGETS = 6;

/** The resume's saved targets, most recently used first (never empty). */
export function targetsFor(resume: { extracted: unknown; targets: unknown }): InterviewTarget[] {
  const saved = z.array(targetSchema).safeParse(resume.targets);
  return saved.success && saved.data.length > 0 ? saved.data : [defaultTarget(resume)];
}

/**
 * Saved targets plus every role this resume has actually been planned for, most
 * recent first. Roles used before the list existed (or never saved) still show up.
 */
export async function targetsWithHistory(resume: {
  id: string;
  extracted: unknown;
  targets: unknown;
}): Promise<InterviewTarget[]> {
  const saved = z.array(targetSchema).safeParse(resume.targets);
  const list: InterviewTarget[] = saved.success ? [...saved.data] : [];

  const past = await prisma.blueprint.findMany({
    where: { resumeId: resume.id },
    orderBy: { createdAt: 'desc' },
    select: {
      role: true,
      level: true,
      difficulty: true,
      durationMin: true,
      voice: true,
      jdId: true,
    },
    take: 50,
  });
  for (const b of past) {
    const known = list.some((t) => t.role.trim().toLowerCase() === b.role.trim().toLowerCase());
    if (known) continue;
    const t = targetSchema.safeParse({ ...b, jdId: b.jdId ?? undefined });
    if (t.success) list.push(t.data);
  }
  return list.length > 0 ? list.slice(0, MAX_TARGETS) : [defaultTarget(resume)];
}

/** The target "Start interview" uses: the one used last. */
export function targetFor(resume: { extracted: unknown; targets: unknown }): InterviewTarget {
  return targetsFor(resume)[0]!;
}

/** Remember this target as the most recent one, replacing any earlier entry for the same role. */
export function rememberTarget(
  existing: InterviewTarget[],
  next: InterviewTarget,
): InterviewTarget[] {
  const same = (t: InterviewTarget) =>
    t.role.trim().toLowerCase() === next.role.trim().toLowerCase();
  return [next, ...existing.filter((t) => !same(t))].slice(0, MAX_TARGETS);
}
