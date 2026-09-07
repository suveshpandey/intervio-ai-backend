import { completeJson } from '@/llm/router';
import {
  resumeExtractionPrompt,
  claimExtractionPrompt,
  jdParsePrompt,
} from '@/llm/prompts/extract';
import {
  extractedResumeSchema,
  claimsSchema,
  jdSchema,
  type ExtractedResume,
  type ExtractedClaim,
  type ParsedJd,
} from '@/modules/intelligence/schema';

const MAX_CLAIMS = 20;

export async function extractResume(resumeText: string): Promise<ExtractedResume> {
  const { data } = await completeJson('extract', extractedResumeSchema, resumeExtractionPrompt(resumeText), {
    maxTokens: 2048,
  });
  return data;
}

export async function extractClaims(resumeText: string): Promise<ExtractedClaim[]> {
  // 10–20 claims with skills + scores is a large object — budget generously up front.
  const { data } = await completeJson('extract', claimsSchema, claimExtractionPrompt(resumeText), {
    maxTokens: 4096,
  });
  return dedupeAndCap(data.claims);
}

export async function parseJd(jdText: string): Promise<ParsedJd> {
  const { data } = await completeJson('extract', jdSchema, jdParsePrompt(jdText));
  return data;
}

/** Drop near-duplicate claims, then keep the top N by importance × priority. */
function dedupeAndCap(claims: ExtractedClaim[]): ExtractedClaim[] {
  const seen = new Set<string>();
  const unique = claims.filter((c) => {
    const key = c.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique
    .sort((a, b) => b.importance * b.priority - a.importance * a.priority)
    .slice(0, MAX_CLAIMS);
}
