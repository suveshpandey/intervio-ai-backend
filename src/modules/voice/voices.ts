/**
 * The interviewer voices a candidate can choose from.
 *
 * A short curated list, not Deepgram's full catalogue — these three were picked
 * by ear for a calm, professional interview delivery. All are `flux-*` models on
 * Deepgram's v2 speak API.
 *
 * `speed` and `expressivity` are per-voice on purpose: each voice sits right at a
 * different setting (Marcus needs more expressivity to avoid sounding flat; Priya
 * and Naveen are already calm and read better slightly slowed down).
 */

export interface VoiceOption {
  id: string;
  name: string;
  accent: string;
  description: string;
  /** Deepgram-hosted demo clip, used for the preview button (free, no synthesis). */
  sampleUrl: string;
  /** 1 = natural pace. Below 1 reads as more deliberate. */
  speed: number;
  /** 0 = flat and even, higher is more animated. */
  expressivity: number;
}

export const VOICES: VoiceOption[] = [
  {
    id: 'flux-marcus-en',
    name: 'Marcus',
    accent: 'American',
    description: 'Friendly and warm',
    sampleUrl: 'https://cdn.sanity.io/files/0dsbfl6j/production/8ec4362caf78524acf72c63705924fd27d24de76.wav',
    speed: 1,
    expressivity: 2,
  },
  {
    id: 'flux-priya-en',
    name: 'Priya',
    accent: 'Indian',
    description: 'Calm and reassuring',
    sampleUrl: 'https://cdn.sanity.io/files/0dsbfl6j/production/04999a9b5cec712e3ee2c8a2b6db61583441bf1e.wav',
    speed: 0.95,
    expressivity: 0,
  },
  {
    id: 'flux-naveen-en',
    name: 'Naveen',
    accent: 'Indian',
    description: 'Clear and measured',
    sampleUrl: 'https://cdn.sanity.io/files/0dsbfl6j/production/675c1ed4eac311d065589b96e180c20c2a5b396c.wav',
    speed: 0.95,
    expressivity: 0,
  },
];

export const VOICE_IDS = VOICES.map((v) => v.id) as [string, ...string[]];
export const DEFAULT_VOICE = 'flux-marcus-en';

export const findVoice = (id: string | undefined): VoiceOption =>
  VOICES.find((v) => v.id === id) ?? VOICES.find((v) => v.id === DEFAULT_VOICE)!;
