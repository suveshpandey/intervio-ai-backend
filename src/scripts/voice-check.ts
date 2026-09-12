/**
 * DEV TOOL — verifies the Deepgram wrappers without a browser.
 *
 * Round trip: TTS synthesises questions → we feed that audio back into STT →
 * the transcript should match. If both halves work, the gateway can be built.
 *
 *   npm run voice:check
 */
import { writeFileSync } from 'node:fs';
import { deepgramTts } from '@/modules/voice/deepgram.tts';
import { deepgramStt } from '@/modules/voice/deepgram.stt';
import { TTS_SAMPLE_RATE } from '@/modules/voice/types';
import { env, voiceEnabled } from '@/config/env';

const QUESTIONS = [
  'What was the bottleneck before you added Redis caching and the composite index?',
  'How did you measure the improvement?',
];
const KEYTERMS = ['Redis', 'PostgreSQL', 'BullMQ', 'Kubernetes'];
const OUT = '/tmp/intervio-tts.wav';

/** Minimal RIFF/WAVE header so the PCM is playable in any audio app. */
function wav(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const silence = (ms: number) => Buffer.alloc(Math.floor((TTS_SAMPLE_RATE * 2 * ms) / 1000));

async function main() {
  if (!voiceEnabled) {
    console.error('❌ DEEPGRAM_API_KEY missing from .env');
    process.exit(1);
  }
  console.log(`STT: ${env.DEEPGRAM_STT_MODEL}   TTS: ${env.DEEPGRAM_TTS_MODEL}`);

  // ── 1. TTS — one session, multiple utterances (that's how the gateway will use it) ──
  const c0 = Date.now();
  const tts = await deepgramTts.openSession();
  console.log(`\n▶ TTS session opened in ${Date.now() - c0}ms  (paid once per interview)`);

  const spoken: Buffer[] = [];
  for (const [i, question] of QUESTIONS.entries()) {
    const t0 = Date.now();
    let firstMs = 0;
    const parts: Buffer[] = [];
    for await (const chunk of tts.speak(question)) {
      if (!firstMs) firstMs = Date.now() - t0;
      parts.push(chunk);
    }
    const pcm = Buffer.concat(parts);
    spoken.push(pcm);
    console.log(
      `  turn ${i + 1}: first audio ${String(firstMs).padStart(4)}ms · ` +
        `${(pcm.length / 1024).toFixed(0)}KB · ${(pcm.length / (TTS_SAMPLE_RATE * 2)).toFixed(1)}s speech`,
    );
  }
  tts.close();

  const audio = spoken[0]!;
  writeFileSync(OUT, wav(audio, TTS_SAMPLE_RATE));
  console.log(`  💾 ${OUT}  (play it to hear the interviewer)`);
  if (!audio.length) throw new Error('TTS produced no audio');

  // ── 2. STT — feed that audio back, with trailing silence like a real mic ──
  console.log('\n▶ STT  (transcribing that audio back)');
  const s0 = Date.now();
  let finalText = '';
  let interims = 0;
  let utteranceEnded = false;

  const stream = await deepgramStt.openStream({
    sampleRate: TTS_SAMPLE_RATE,
    keyterms: KEYTERMS,
    onTranscript: ({ text, isFinal }) => {
      if (isFinal) finalText += (finalText ? ' ' : '') + text;
      else interims++;
    },
    onUtteranceEnd: () => {
      utteranceEnded = true;
    },
    onError: (err) => console.error('  stt error:', err.message),
  });

  // Real mics always trail off into silence — that's what triggers turn detection.
  const withSilence = Buffer.concat([audio, silence(1500)]);
  const frame = Math.floor(TTS_SAMPLE_RATE * 2 * 0.1); // 100ms slices
  for (let i = 0; i < withSilence.length; i += frame) {
    stream.send(withSilence.subarray(i, i + frame));
    await sleep(30);
  }
  stream.finalize();

  for (let i = 0; i < 60 && !utteranceEnded; i++) await sleep(100);
  stream.close();

  console.log(`  ✓ ${interims} interim results   (live captions)`);
  console.log(`  ${utteranceEnded ? '✓' : '✗'} utteranceEnd fired      (turn detection)`);
  console.log(`  ⏱  ${Date.now() - s0}ms`);
  console.log(`\n  said:  "${QUESTIONS[0]}"`);
  console.log(`  heard: "${finalText}"`);

  if (!finalText.trim()) throw new Error('STT produced no final transcript');

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const said = norm(QUESTIONS[0]!);
  const heard = new Set(norm(finalText));
  const overlap = said.filter((w) => heard.has(w)).length / said.length;
  console.log(`  word overlap: ${(overlap * 100).toFixed(0)}%`);

  const ok = overlap >= 0.9 && utteranceEnded;
  console.log(ok ? '\n✅ VOICE ROUND TRIP PASSED' : '\n⚠️  check the warnings above');
}

main().catch((err) => {
  console.error('\n❌ FAILED:', err?.message ?? err);
  process.exit(1);
});
