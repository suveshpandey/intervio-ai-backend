import { Router } from 'express';
import { VOICES, DEFAULT_VOICE } from '@/modules/voice/voices';
import { rateLimit } from '@/common/rate-limit';

export const voiceRouter = Router();

/**
 * The curated interviewer voices: the interview config screen, and the landing
 * page's voice preview. Public on purpose — it is a fixed catalogue with no user
 * data in it, and the landing page has no session to authenticate with.
 */
voiceRouter.get('/', rateLimit({ name: 'voices', limit: 120, windowSec: 60 * 60 }), (_req, res) => {
  res.json({ voices: VOICES, defaultVoice: DEFAULT_VOICE });
});
