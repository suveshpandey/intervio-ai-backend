import { z } from 'zod';

// ── Fixed interview shape (order matters; the engine walks these in sequence) ──
export const SECTION_KEYS = ['intro', 'claim_verification', 'fundamentals', 'problem_solving', 'wrap'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_TITLES: Record<SectionKey, string> = {
  intro: 'Warm-up & intro',
  claim_verification: 'Claim verification',
  fundamentals: 'Fundamentals',
  problem_solving: 'Problem solving',
  wrap: 'Wrap-up',
};

/** Fallback time split when the LLM's budgets are missing or unusable. */
export const SECTION_WEIGHTS: Record<SectionKey, number> = {
  intro: 0.1,
  claim_verification: 0.4,
  fundamentals: 0.2,
  problem_solving: 0.25,
  wrap: 0.05,
};

export const LEVELS = ['junior', 'mid', 'senior'] as const;
export const DIFFICULTIES = ['easy', 'standard', 'hard'] as const;

/** Config the user confirms before we generate the plan. */
export const blueprintConfigSchema = z.object({
  resumeId: z.string().uuid(),
  jdId: z.string().uuid().optional(),
  role: z.string().min(1).max(120),
  level: z.enum(LEVELS),
  difficulty: z.enum(DIFFICULTIES),
  durationMin: z.number().int().min(5).max(60),
});
export type BlueprintConfig = z.infer<typeof blueprintConfigSchema>;

/** Raw LLM planner output — loose on purpose; our code validates and fixes it. */
export const planLlmSchema = z.object({
  probeClaimIds: z.array(z.string()).default([]),
  sections: z
    .array(z.object({ key: z.string(), budgetMin: z.number() }))
    .default([]),
});

/** The validated, stored section shape. */
export interface PlanSection {
  key: SectionKey;
  title: string;
  budgetMin: number;
}
