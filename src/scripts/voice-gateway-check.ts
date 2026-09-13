/**
 * DEV TOOL — proves a full interview turn works over the voice WebSocket,
 * using typed answers (no microphone). This is the Phase 4 step-2 checkpoint.
 *
 *   npm run voice:gateway
 */
import WebSocket from 'ws';
import { prisma } from '@/db/prisma';
import { redis } from '@/db/redis';
import { env } from '@/config/env';

const API = `http://localhost:${env.PORT}`;
const WS_URL = `ws://localhost:${env.PORT}/voice`;

const ANSWERS = [
  "I'm a full-stack developer with three years of experience, mostly React, Node and Postgres.",
  'The dashboard endpoint joined four tables with no index on the transactions timestamp, so it did a full scan. I added a composite index and cached the aggregate in Redis with a 60 second TTL.',
];

async function seed() {
  const email = `ws-check-${Date.now()}@example.com`;
  const signup = await fetch(`${API}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'testpass123', name: 'WS Check' }),
  });
  const cookie = (signup.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });

  const resume = await prisma.resume.create({
    data: {
      userId: user.id, fileUrl: 'x', fileName: 'x.pdf', fileHash: 'x', parseStatus: 'done',
      extracted: { skills: ['Redis', 'PostgreSQL', 'Node.js'], projects: [], experience: [] },
    },
  });
  const claim = await prisma.claim.create({
    data: {
      resumeId: resume.id, text: 'Reduced API p95 latency from 800ms to 180ms with Redis caching.',
      category: 'impact', relatedSkills: ['Redis'], importance: 5, priority: 5,
    },
  });
  const blueprint = await prisma.blueprint.create({
    data: {
      userId: user.id, resumeId: resume.id, role: 'Full-Stack Engineer', level: 'mid',
      difficulty: 'standard', durationMin: 15,
      sections: [
        { key: 'intro', title: 'Warm-up & intro', budgetMin: 2 },
        { key: 'claim_verification', title: 'Claim verification', budgetMin: 6 },
        { key: 'fundamentals', title: 'Fundamentals', budgetMin: 3 },
        { key: 'problem_solving', title: 'Problem solving', budgetMin: 3 },
        { key: 'wrap', title: 'Wrap-up', budgetMin: 1 },
      ],
      probeClaimIds: [claim.id],
    },
  });
  return { cookie, blueprintId: blueprint.id };
}

async function main() {
  console.log('▶ seeding user + blueprint');
  const { cookie, blueprintId } = await seed();

  console.log('▶ POST /interviews');
  const started = (await (
    await fetch(`${API}/interviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ blueprintId }),
    })
  ).json()) as { interviewId: string; question: string };
  const interviewId = started.interviewId;
  console.log(`  ✓ ${interviewId}`);
  console.log(`  Q0: ${started.question}`);

  console.log('▶ POST /interviews/:id/voice-ticket');
  const { ticket } = (await (
    await fetch(`${API}/interviews/${interviewId}/voice-ticket`, { method: 'POST', headers: { cookie } })
  ).json()) as { ticket: string };
  console.log(`  ✓ ticket ${String(ticket).slice(0, 12)}… (60s, single use)`);

  console.log('▶ opening WebSocket');
  const ws = new WebSocket(`${WS_URL}?ticket=${ticket}`);
  let audioBytes = 0;
  let questions = 0;
  let answersSent = 0;
  const seen = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for turns')), 120_000);

    ws.on('open', () => console.log('  ✓ connected'));
    ws.on('error', reject);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        audioBytes += data.length;
        return;
      }
      const msg = JSON.parse(data.toString()) as { type: string; [k: string]: unknown };
      seen.add(msg.type);

      switch (msg.type) {
        case 'state':
          console.log(`  · state: section=${msg.sectionKey} turn=${msg.turnIdx} left=${msg.secondsLeft}s`);
          break;
        case 'question':
          questions++;
          console.log(`  🎤 Q${msg.turnIdx}: ${msg.text}`);
          break;
        case 'thinking':
          console.log('  · thinking…');
          break;
        case 'speech_end': {
          console.log(`  · audio done (${(audioBytes / 1024).toFixed(0)}KB so far)`);
          const next = ANSWERS[answersSent];
          if (next) {
            answersSent++;
            console.log(`  🗣️  ${next.slice(0, 70)}…`);
            ws.send(JSON.stringify({ type: 'text_answer', text: next }));
          } else {
            clearTimeout(timer);
            resolve();
          }
          break;
        }
        case 'done':
          clearTimeout(timer);
          resolve();
          break;
        case 'error':
          clearTimeout(timer);
          reject(new Error(`${msg.code}: ${msg.message}`));
          break;
      }
    });
  });

  ws.close();

  console.log('\n▶ ticket reuse must fail');
  const replay = new WebSocket(`${WS_URL}?ticket=${ticket}`);
  const replayRejected = await new Promise<boolean>((resolve) => {
    replay.on('open', () => resolve(false));
    replay.on('error', () => resolve(true));
    setTimeout(() => resolve(false), 5000);
  });
  console.log(`  ${replayRejected ? '✓' : '✗'} second use rejected`);

  console.log('\n─────────────────────────────');
  console.log(`questions asked : ${questions}`);
  console.log(`answers sent    : ${answersSent}`);
  console.log(`TTS audio       : ${(audioBytes / 1024).toFixed(0)} KB`);
  console.log(`messages seen   : ${[...seen].join(', ')}`);

  const ok = questions >= 2 && audioBytes > 0 && replayRejected;
  console.log(ok ? '\n✅ GATEWAY CHECKPOINT PASSED' : '\n❌ CHECKPOINT FAILED');

  await prisma.$disconnect();
  await redis.quit();
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\n❌ FAILED:', err?.message ?? err);
  await prisma.$disconnect().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(1);
});
