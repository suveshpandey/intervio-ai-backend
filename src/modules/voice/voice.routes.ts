import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { VOICES, DEFAULT_VOICE } from '@/modules/voice/voices';

export const voiceRouter = Router();

/** The curated interviewer voices, for the config screen. */
voiceRouter.get('/', requireAuth, (_req, res) => {
  res.json({ voices: VOICES, defaultVoice: DEFAULT_VOICE });
});
