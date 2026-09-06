/**
 * ⭐ Source of truth for cross-boundary contracts (shared with the frontend).
 *
 * The WebSocket voice protocol (audio_frame, transcript, ai_question, tts_chunk,
 * section_change, state, error, end) and the LLM output Zod schemas will live here
 * and are copied into intervio-frontend/src/lib/contracts via `npm run sync:contracts`.
 *
 * Phase 0 ships only the shared auth/user shape so the frontend has a typed `/me`.
 * These grow in Phases 3–4.
 */

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  authProvider: 'email' | 'google';
}
