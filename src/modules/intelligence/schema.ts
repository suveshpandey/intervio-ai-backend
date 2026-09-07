import { z } from 'zod';

// ── Resume extraction (skills / projects / experience) ──
export const extractedResumeSchema = z.object({
  skills: z.array(z.string()).default([]),
  projects: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().default(''),
        tech: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  experience: z
    .array(
      z.object({
        company: z.string().optional(),
        role: z.string().optional(),
        duration: z.string().optional(),
        highlights: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  summary: z.string().optional(),
});
export type ExtractedResume = z.infer<typeof extractedResumeSchema>;

// ── Claim extraction ──
export const claimSchema = z.object({
  text: z.string(),
  category: z.string(), // scale | impact | ownership | tech-depth | leadership | other
  related_skills: z.array(z.string()).default([]),
  importance: z.number().int().min(1).max(5),
  priority: z.number().int().min(1).max(5),
});
export const claimsSchema = z.object({ claims: z.array(claimSchema).default([]) });
export type ExtractedClaim = z.infer<typeof claimSchema>;

// ── JD parsing ──
export const jdSchema = z.object({
  required_skills: z.array(z.string()).default([]),
});
export type ParsedJd = z.infer<typeof jdSchema>;
