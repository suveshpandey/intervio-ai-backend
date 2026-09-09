/**
 * DEV TOOL — not shipped (PRD Phase 3).
 *
 * Feeds typed answers to the interview engine and prints the conversation plus
 * the engine's reasoning, so the adaptive logic can be verified before any
 * microphone exists.
 *
 *   npm run harness                 # scripted answers (exercises the guardrails)
 *   npm run harness -- --interactive # type your own answers
 *   npm run harness -- --blueprint <id>
 */

import { createInterface } from 'node:readline/promises';
import { prisma } from '@/db/prisma';
import { redis } from '@/db/redis';
import { startInterview, submitAnswer, type TurnResult } from '@/modules/interview/engine/orchestrator';
import { stateStore } from '@/modules/interview/state.store';

const MAX_TURNS = 30;

/** Deliberately mixed quality, to push the engine down each guardrail. */
const SCRIPTED = [
  "I'm a full-stack developer with about three years of experience, mostly React and Node with Postgres. Recently I've been doing a lot of AI integration work.",
  'The dashboard endpoint was joining four tables and there was no index on the transactions timestamp column, so it did a full sequential scan. I added a composite index on (tenant_id, created_at) and cached the aggregate in Redis with a 60 second TTL.',
  'We used caching to make it faster and improve performance for the users.',
  "Honestly I'm not sure, I didn't measure that part myself.",
  'We ran it behind a load balancer with two instances, and I used a connection pool of 20 per instance. Under load testing with k6 we saw about 400 requests per second before latency degraded.',
  'It was mostly standard best practices, we followed the usual patterns.',
  'I used a cursor-based delta poll every 3.5 seconds instead of websockets, because the websocket connections were dropping behind the corporate proxy and reconnect storms were hammering the server.',
  "I don't really know that one.",
  'I would probably start by profiling to find where the time actually goes, then look at whether it is CPU or IO bound before optimising anything.',
  'Yes, I have a question — what does the team use for observability?',
];

function bar(char = '─', n = 72) {
  return char.repeat(n);
}

function printTurn(idx: number, section: string, question: string) {
  console.log(`\n${bar()}`);
  console.log(`TURN ${idx}  ·  section: ${section}`);
  console.log(bar());
  console.log(`\n🎤 INTERVIEWER: ${question}`);
}

function printDebug(r: TurnResult) {
  const d = r.debug;
  if (!d) return;
  const e = d.evaluation;
  console.log(
    `\n   ├─ scores    quality ${e.answerQuality.toFixed(2)} · depth ${e.technicalDepth.toFixed(2)} · claim: ${e.claimEvidence} · issue: ${e.issue}`,
  );
  console.log(`   ├─ model    suggested ${e.actionSuggested} — ${e.reason}`);
  console.log(
    `   └─ ENGINE   ${d.action}${d.overrode ? '  ⚠️  OVERRODE MODEL' : ''} · difficulty ${d.difficulty}\n              ${d.rationale}`,
  );
}

async function summarise(interviewId: string) {
  const state = await stateStore.load(interviewId);
  const turns = await prisma.turn.findMany({ where: { interviewId }, orderBy: { idx: 'asc' } });
  const evidence = await prisma.evidence.findMany({ where: { interviewId } });

  console.log(`\n\n${bar('═')}`);
  console.log('SUMMARY');
  console.log(bar('═'));
  console.log(`turns: ${turns.length} · evidence rows: ${evidence.length}`);

  if (!state) return;
  console.log(`\nclaim outcomes:`);
  const ids = Object.keys(state.claims);
  const claims = await prisma.claim.findMany({ where: { id: { in: ids } } });
  const byId = new Map(claims.map((c) => [c.id, c]));
  for (const [id, p] of Object.entries(state.claims)) {
    const text = byId.get(id)?.text.slice(0, 58) ?? id;
    console.log(
      `  [${p.status.padEnd(12)}] conf ${p.confidence.toFixed(2)} · ${p.turnsSpent} turn(s) · ${text}`,
    );
  }

  const skills = Object.entries(state.skills);
  if (skills.length) {
    console.log(`\nskill signals:`);
    for (const [s, v] of skills) console.log(`  ${s}: ${v.score.toFixed(2)} (${v.samples})`);
  }
  console.log(`\nrolling summary:`);
  for (const line of state.rollingSummary) console.log(`  - ${line}`);
}

async function main() {
  const args = process.argv.slice(2);
  const interactive = args.includes('--interactive');
  const bpArg = args.indexOf('--blueprint');
  const blueprintId = bpArg !== -1 ? args[bpArg + 1] : undefined;

  const blueprint = blueprintId
    ? await prisma.blueprint.findUnique({ where: { id: blueprintId } })
    : await prisma.blueprint.findFirst({ orderBy: { createdAt: 'desc' } });

  if (!blueprint) {
    console.error('No blueprint found. Generate one first (POST /blueprints or the review page).');
    process.exit(1);
  }

  console.log(
    `Blueprint ${blueprint.id}\n${blueprint.role} · ${blueprint.level} · ${blueprint.difficulty} · ${blueprint.durationMin}min · ${blueprint.probeClaimIds.length} claims`,
  );

  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  let turn = await startInterview(blueprint.userId, blueprint.id);
  printTurn(turn.turnIdx, turn.sectionKey, turn.question!);

  let i = 0;
  while (!turn.done && i < MAX_TURNS) {
    const answer = rl
      ? (await rl.question('\n🗣️  YOU: ')).trim()
      : (SCRIPTED[i % SCRIPTED.length] as string);

    if (!rl) console.log(`\n🗣️  CANDIDATE: ${answer}`);
    if (answer === 'quit') break;

    turn = await submitAnswer(blueprint.userId, turn.interviewId, answer);
    printDebug(turn);
    i++;

    if (turn.done) {
      console.log(`\n${bar()}\n✅ Interview complete.`);
      break;
    }
    printTurn(turn.turnIdx, turn.sectionKey, turn.question!);
  }

  rl?.close();
  await summarise(turn.interviewId);
  await prisma.$disconnect();
  await redis.quit();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Harness failed:', err);
  await prisma.$disconnect().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(1);
});
