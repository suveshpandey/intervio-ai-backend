import { z } from 'zod';

/**
 * Runtime validation for browser → server messages.
 *
 * The socket used to `JSON.parse` and cast straight to `ClientMessage`, so every
 * field was whatever the client said it was. `text_answer` in particular went
 * into a paid LLM call with no length cap, while its HTTP twin capped it at 5000.
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('mute') }),
  z.object({ type: z.literal('unmute') }),
  z.object({ type: z.literal('end') }),
  // Same cap as POST /interviews/:id/answer — untrusted text headed for an LLM.
  z.object({ type: z.literal('text_answer'), text: z.string().trim().min(1).max(5000) }),
  z.object({
    type: z.literal('mic_info'),
    contextSampleRate: z.number().int().positive().max(384_000),
    targetSampleRate: z.number().int().positive().max(384_000),
  }),
]);

export type ValidatedClientMessage = z.infer<typeof clientMessageSchema>;
