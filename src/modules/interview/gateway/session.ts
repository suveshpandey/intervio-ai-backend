import type { WebSocket } from 'ws';
import { logger } from '@/common/logger';
import type { ServerMessage } from '@/contracts/voice';
import { clientMessageSchema, type ValidatedClientMessage } from '@/contracts/voice.schema';
import { deepgramStt } from '@/modules/voice/deepgram.stt';
import { deepgramTts } from '@/modules/voice/deepgram.tts';
import { STT_SAMPLE_RATE, type SttStream, type TtsSession } from '@/modules/voice/types';
import { stateStore } from '@/modules/interview/state.store';
import { interviewRepository } from '@/modules/interview/interview.repository';
import { submitAnswer, prepareTurn, type PreparedTurn } from '@/modules/interview/engine/orchestrator';
import { clearPrefetch } from '@/modules/interview/engine/prefetch';
import { usage } from '@/modules/usage/usage.repository';
import { runWithContext } from '@/common/context';
import { env } from '@/config/env';
import { prisma } from '@/db/prisma';
import type { PlanSection } from '@/modules/planner/schema';
import type { InterviewState } from '@/modules/interview/types';
import type { TicketPayload } from '@/modules/interview/gateway/ticket';

/** Loudest sample in a PCM16 frame — tells real speech apart from near-silence. */
function peakAmplitude(frame: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < frame.length; i += 2) {
    const v = Math.abs(frame.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * How long a pause before we start scoring the answer in the background.
 *
 * This only starts THINKING early; it never ends the turn. The turn still
 * commits on Deepgram's utterance end alone (see the note below) — an earlier
 * second commit-trigger made the interview hang. Speculation that turns out
 * wrong (they kept talking) is cancelled and costs one cheap model call.
 */
const SPECULATE_AFTER_MS = 600;

/** Slack past the interview's own end before the socket is force-closed. */
const SESSION_GRACE_MS = 2 * 60_000;

/**
 * Turn end is decided by Deepgram's `utterance_end_ms` alone (see deepgram.stt.ts).
 *
 * Do NOT add a second debounce on top of it. A previous version restarted a local
 * timer on every transcript; with a real microphone there is always faint room
 * noise, so stray interim results kept pushing the commit further out — the turn
 * either arrived seconds late or never fired at all. Deepgram's silence timer is
 * already the debounce; tune UTTERANCE_END_MS instead of layering on more.
 */

/**
 * One live voice interview over one WebSocket.
 *
 * Holds the Deepgram STT stream and TTS session open for the whole interview —
 * opening them costs 2-4s, speaking on an open one costs ~400ms.
 *
 * Half-duplex (PRD): while the interviewer is speaking we ignore mic audio, so
 * the AI can never hear itself.
 */
export class VoiceSession {
  private stt: SttStream | null = null;
  private tts: TtsSession | null = null;

  /** Final transcript fragments for the current turn. */
  private answerParts: string[] = [];
  private speaking = false;
  private muted = false;
  private busy = false;
  private closed = false;
  /** When the current question finished playing — diagnostics only. */
  private listeningSince = Date.now();
  /**
   * The interview clock is REAL TIME since it started and never pauses — closing
   * the tab doesn't buy you more time, and a sweeper finishes it once the
   * duration is up. `state.totalElapsedSec` is accurate up to this instant.
   */
  private clockMark = Date.now();
  private micFrames = 0;
  private droppedFrames = 0;
  /** Loudest sample since the last heartbeat log (a single frame is just a pause-or-word sample). */
  private windowPeak = 0;
  private keyterms: string[] = [];
  private reconnecting = false;
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Background scoring of the answer so far, started during a pause. */
  private speculation: {
    answer: string;
    controller: AbortController;
    result: Promise<PreparedTurn | null>;
  } | null = null;
  private speculateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last time the candidate said anything — the start of the silence they sit through. */
  private lastSpeechAt = 0;
  /** Metering: audio streamed to Deepgram, and characters it spoke back. */
  private sttBytes = 0;
  private ttsChars = 0;

  /** Blueprint bits needed to report progress; loaded once at start. */
  private sections: PlanSection[] = [];
  private durationMin = 0;
  private voice: string | undefined;

  /** Per-session logger so every line carries the interview id. */
  private readonly log;

  constructor(
    private readonly ws: WebSocket,
    private readonly ticket: TicketPayload,
  ) {
    this.log = logger.child({ interviewId: ticket.interviewId });
  }

  async start(): Promise<void> {
    const state = await stateStore.load(this.ticket.interviewId);
    if (!state) {
      this.send({ type: 'error', code: 'state_expired', message: 'This interview has expired.' });
      this.ws.close();
      return;
    }

    // Prime STT with the candidate's own tech terms so jargon survives transcription.
    const keyterms = await this.loadBlueprint();

    this.tts = await deepgramTts.openSession({ model: this.voice });
    this.keyterms = keyterms;
    await this.openStt();

    this.log.info(
      { voice: this.voice, keyterms: keyterms.length, pending: Boolean(state.pendingQuestion) },
      'voice session started',
    );
    // Anchor the clock to the real start, so time spent away still counts.
    const startedAt = await interviewRepository.startedAt(this.ticket.interviewId);
    this.clockMark = (startedAt?.getTime() ?? Date.now()) + state.totalElapsedSec * 1000;

    // Hard stop: two paid Deepgram streams must not outlive the interview itself,
    // however quiet the client goes.
    const endsInMs =
      (startedAt?.getTime() ?? Date.now()) + this.durationMin * 60_000 + SESSION_GRACE_MS - Date.now();
    this.lifetimeTimer = setTimeout(() => {
      this.log.info('voice session hit its time limit — closing');
      this.close();
    }, Math.max(60_000, endsInMs));
    this.lifetimeTimer.unref();
    this.sendState(state);

    // Speak whatever question is already pending (the interview was started over HTTP).
    if (state.pendingQuestion) {
      this.send({
        type: 'question',
        text: state.pendingQuestion,
        turnIdx: state.turnIdx,
        sectionKey: this.sectionKey(state),
      });
      await this.speak(state.pendingQuestion);
    }
  }

  /** Opens (or re-opens) the speech-to-text stream. */
  private async openStt(): Promise<void> {
    this.stt = await deepgramStt.openStream({
      sampleRate: STT_SAMPLE_RATE,
      keyterms: this.keyterms,
      onTranscript: ({ text, isFinal }) => {
        if (this.speaking) return; // ignore anything picked up while we talk
        this.send({ type: 'transcript', text, isFinal });
        if (text.trim()) {
          this.lastSpeechAt = Date.now();
          // They're still talking: no point thinking about an unfinished answer.
          this.cancelSpeculateTimer();
        }
        if (isFinal) {
          this.answerParts.push(text);
          this.log.debug({ text: text.slice(0, 60) }, 'final transcript');
          // A settled phrase: if they now stay quiet, start scoring in the background.
          if (text.trim()) this.scheduleSpeculation();
        }
      },
      onUtteranceEnd: () => this.onUtteranceEnd(),
      onError: (err) => this.log.error({ err }, 'STT stream error'),
      onClose: () => void this.reopenStt(),
    });
  }

  /**
   * Deepgram dropped the stream. Without this the interview silently dies: mic
   * frames keep arriving and get written to a closed socket, so no transcript
   * ever comes back and the candidate waits forever.
   */
  private async reopenStt(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    try {
      this.log.warn('STT stream closed — reconnecting');
      await this.openStt();
      this.log.info('STT stream reconnected');
    } catch (err) {
      this.log.error({ err }, 'STT reconnect failed');
      this.send({
        type: 'error',
        code: 'stt_lost',
        message: 'Lost the microphone stream. Please refresh.',
      });
    } finally {
      this.reconnecting = false;
    }
  }

  handleMessage(data: Buffer, isBinary: boolean): void {
    if (this.closed) return;

    if (isBinary) {
      // Half-duplex: drop mic audio while the interviewer is talking.
      if (this.speaking || this.muted || this.busy) {
        this.droppedFrames++;
        return;
      }
      if (this.stt && !this.stt.open) {
        void this.reopenStt();
        return;
      }
      this.micFrames++;
      this.sttBytes += data.length;
      this.windowPeak = Math.max(this.windowPeak, peakAmplitude(data));
      // Periodic heartbeat: proves audio is still reaching STT during a silent hang.
      if (this.micFrames % 50 === 0) {
        this.log.debug(
          {
            micFrames: this.micFrames,
            dropped: this.droppedFrames,
            parts: this.answerParts.length,
            bytes: data.length,
            // 0-32767, loudest over the last ~5s. Normal speech lands ~5000+;
            // if this stays low while talking, the mic itself is too quiet.
            peak: this.windowPeak,
          },
          'mic audio flowing',
        );
        this.windowPeak = 0;
      }
      this.stt?.send(data);
      return;
    }

    // Validate before use: everything below this line used to be whatever the
    // client claimed, including an unbounded `text_answer`.
    let msg: ValidatedClientMessage;
    try {
      const parsed = clientMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) {
        this.log.warn({ issues: parsed.error.issues.slice(0, 2) }, 'ignored malformed client message');
        return;
      }
      msg = parsed.data;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'mute':
        this.muted = true;
        break;
      case 'unmute':
        this.muted = false;
        break;
      case 'end':
        // Candidate pressed "End interview". Mark it ended, then hang up.
        // NOTE: only the explicit message does this — a plain socket close (wifi
        // blip, closed tab) must leave the row `live` so a refresh can resume it.
        void this.endEarly();
        break;
      case 'mic_info':
        this.log.info(
          { contextSampleRate: msg.contextSampleRate, targetSampleRate: msg.targetSampleRate },
          msg.contextSampleRate === msg.targetSampleRate
            ? 'mic ready'
            : 'mic ready (browser refused our rate — worklet is resampling)',
        );
        break;
      case 'text_answer':
        // Dev path: a full turn without a microphone. Never in production, where
        // it would be a way to drive paid LLM calls without speaking.
        if (env.NODE_ENV === 'production') {
          this.log.warn('text_answer rejected — voice only in production');
          break;
        }
        void this.finishTurn(msg.text);
        break;
      default:
        break;
    }
  }

  /** Deepgram decided the candidate stopped talking — commit the turn. */
  private onUtteranceEnd(): void {
    if (this.busy || this.closed) return;
    const answer = this.answerParts.join(' ').trim();
    if (!answer) {
      this.log.debug('utteranceEnd with no transcript — still listening');
      return;
    }
    this.log.info({ ms: Date.now() - this.listeningSince }, 'turn committed');
    void this.finishTurn(answer);
  }

  private finishTurn(answer: string): Promise<void> {
    // A turn is not an HTTP request, so nothing has set the work context yet.
    return runWithContext({ userId: this.ticket.userId, interviewId: this.ticket.interviewId }, () =>
      this.runTurn(answer),
    );
  }

  private async runTurn(answer: string): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.answerParts = [];

    try {
      this.send({ type: 'thinking' });
      const tStart = Date.now();

      // Charge the clock with ALL real time since the last mark — question audio,
      // the answer, and the previous turn's thinking — so the engine's clock and
      // the one on screen are the same clock.
      const turnSeconds = this.takeClockSeconds();

      // Scored during their pause? Use it if it judged exactly this answer;
      // otherwise it's discarded and the turn scores normally.
      const prepared = await this.takeSpeculation(answer);

      const result = await submitAnswer(this.ticket.userId, this.ticket.interviewId, answer, turnSeconds, prepared);

      const tEngine = Date.now() - tStart;

      if (result.done || !result.question) {
        this.send({ type: 'done' });
        this.close();
        return;
      }

      this.send({
        type: 'question',
        text: result.question,
        turnIdx: result.turnIdx,
        sectionKey: result.sectionKey,
      });
      await this.refreshState();
      const tSpeakStart = Date.now();
      const firstByteMs = await this.speak(result.question);
      this.log.info(
        {
          engineMs: tEngine,
          // true = the next-topic question was written while they were answering.
          prefetched: result.debug?.prefetched ?? false,
          // true = scored during the pause, so the model's time was hidden.
          speculative: result.debug?.speculative ?? false,
          // What the candidate actually sat through: their last word → our first sound.
          silenceMs: this.lastSpeechAt ? tSpeakStart + firstByteMs - this.lastSpeechAt : null,
          ttsFirstByteMs: firstByteMs,
          ttsTotalMs: Date.now() - tSpeakStart,
          totalMs: Date.now() - tStart,
          answerChars: answer.length,
        },
        'turn latency',
      );
    } catch (err) {
      logger.error({ err }, 'Voice turn failed');
      this.send({
        type: 'error',
        code: 'turn_failed',
        message: 'Something went wrong. Try again.',
      });
    } finally {
      this.busy = false;
    }
  }

  /**
   * Stream TTS audio to the browser, then hand the floor back to the candidate.
   * @returns ms until the first audio chunk went out (the number the user feels).
   */
  private async speak(text: string): Promise<number> {
    if (!this.tts || this.closed) return 0;
    this.speaking = true;
    this.ttsChars += text.length;
    const t0 = Date.now();
    let firstByteMs = 0;
    try {
      for await (const chunk of this.tts.speak(text)) {
        if (this.closed) break;
        if (!firstByteMs) firstByteMs = Date.now() - t0;
        this.ws.send(chunk, { binary: true });
      }
    } catch (err) {
      // TTS failed — the caption is already on screen, so the interview continues.
      logger.error({ err }, 'TTS failed; falling back to text-only for this turn');
      this.send({
        type: 'error',
        code: 'tts_failed',
        message: 'Audio unavailable for that question.',
      });
    } finally {
      this.speaking = false;
      this.answerParts = [];
      this.listeningSince = Date.now();
      this.send({ type: 'speech_end' });
    }
    return firstByteMs;
  }

  private async refreshState(): Promise<void> {
    const state = await stateStore.load(this.ticket.interviewId);
    if (state) this.sendState(state);
  }

  private sectionKey(state: InterviewState): string {
    return this.sections[state.sectionIdx]?.key ?? 'unknown';
  }

  /** Whole seconds elapsed since the mark; advances the mark by exactly that (no drift). */
  private takeClockSeconds(): number {
    const secs = Math.max(0, Math.floor((Date.now() - this.clockMark) / 1000));
    this.clockMark += secs * 1000;
    return secs;
  }

  /** Includes the still-running time since the mark, so the browser gets the live value. */
  private sendState(state: InterviewState): void {
    const running = (Date.now() - this.clockMark) / 1000;
    this.send({
      type: 'state',
      sectionKey: this.sectionKey(state),
      turnIdx: state.turnIdx,
      secondsLeft: Math.max(0, Math.round(this.durationMin * 60 - state.totalElapsedSec - running)),
    });
  }

  /**
   * One usage row per session rather than per frame: a 15-minute interview is
   * ~9000 mic frames, and nobody needs 9000 rows to know what it cost.
   */
  private meterAudio(): void {
    const seconds = this.sttBytes / (STT_SAMPLE_RATE * 2); // PCM16 = 2 bytes/sample
    runWithContext({ userId: this.ticket.userId, interviewId: this.ticket.interviewId }, () => {
      usage.stt(env.DEEPGRAM_STT_MODEL, seconds);
      usage.tts(this.voice ?? env.DEEPGRAM_TTS_MODEL, this.ttsChars);
    });
  }

  /* ── speculative scoring (start thinking during the pause) ── */

  private cancelSpeculateTimer(): void {
    if (this.speculateTimer) clearTimeout(this.speculateTimer);
    this.speculateTimer = null;
  }

  private scheduleSpeculation(): void {
    this.cancelSpeculateTimer();
    this.speculateTimer = setTimeout(() => {
      this.speculateTimer = null;
      this.startSpeculation();
    }, SPECULATE_AFTER_MS);
  }

  private startSpeculation(): void {
    if (this.closed || this.speaking || this.busy || this.muted) return;
    const answer = this.answerParts.join(' ').trim();
    if (!answer) return;
    if (this.speculation?.answer === answer) return; // already thinking about exactly this

    // A longer answer replaces an older guess.
    this.dropSpeculation();
    const controller = new AbortController();
    const result = prepareTurn(this.ticket.userId, this.ticket.interviewId, answer, controller.signal).catch(
      () => null,
    );
    this.speculation = { answer, controller, result };
    this.log.debug({ chars: answer.length }, 'speculative scoring started');
  }

  /** Cancel any in-flight speculation (they kept talking, or we're closing). */
  private dropSpeculation(): void {
    this.cancelSpeculateTimer();
    if (!this.speculation) return;
    this.speculation.controller.abort();
    this.speculation = null;
  }

  /**
   * At commit: the speculative result, if it scored this exact answer. Waits for
   * it if it's still running — never slower than starting the call from scratch.
   */
  private async takeSpeculation(answer: string): Promise<PreparedTurn | null> {
    this.cancelSpeculateTimer();
    const spec = this.speculation;
    this.speculation = null;
    if (!spec) return null;
    if (spec.answer !== answer) {
      spec.controller.abort();
      this.log.debug('speculation discarded — answer changed after it started');
      return null;
    }
    const prepared = await spec.result;
    this.log.debug({ hit: Boolean(prepared) }, 'speculation used');
    return prepared;
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /**
   * Loads the blueprint once (sections + duration for progress) and returns the
   * candidate's own skills, so Deepgram doesn't mangle their jargon.
   */
  private async loadBlueprint(): Promise<string[]> {
    const interview = await prisma.interview.findUnique({
      where: { id: this.ticket.interviewId },
      include: { blueprint: { include: { resume: true } } },
    });
    if (!interview) return [];
    this.sections = (interview.blueprint.sections as unknown as PlanSection[]) ?? [];
    this.durationMin = interview.blueprint.durationMin;
    this.voice = interview.blueprint.voice;
    const extracted = interview.blueprint.resume.extracted as { skills?: string[] } | null;
    return (extracted?.skills ?? []).slice(0, 50);
  }

  /** Stop the interview part-way through at the candidate's request. */
  private async endEarly(): Promise<void> {
    try {
      const ended = await interviewRepository.abandon(this.ticket.interviewId);
      await stateStore.clear(this.ticket.interviewId);
      clearPrefetch(this.ticket.interviewId);
      if (ended) this.log.info('interview ended early by candidate');
    } catch (err) {
      this.log.error({ err }, 'failed to mark interview ended');
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    this.dropSpeculation();
    this.meterAudio();
    this.stt?.close();
    this.tts?.close();
    if (this.ws.readyState === this.ws.OPEN) this.ws.close();
  }
}
